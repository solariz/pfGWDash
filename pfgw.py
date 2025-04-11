"""
pfSense Gateway Status Monitor (pfGWDash)

This script polls multiple pfSense instances, retrieves gateway status information,
and generates a dynamic HTML status page. It supports both single execution and
daemon mode for continuous monitoring.

For configuration, see the README.md file and config.ini.sample.

Author: Marco G.
GitHub: https://github.com/solariz/pfGWDash
License: MIT

Usage:
    Single execution: python pfgw.py
    Loop mode: python pfgw.py --daemon

The whole thing was coded on an event, so be gentle in your judgement,
if you find any bugs or have improvements, feel free to pull and commit
and commit it back.

thanks
"""
import requests
from bs4 import BeautifulSoup
import urllib3
import re
import json
import os
from datetime import datetime, timedelta
import configparser
from jinja2 import Environment, FileSystemLoader
import time
import argparse

# Import shared functions
from functions import login_pfsense, get_csrf_token, load_auth_data, save_auth_data, log_message

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load configuration
config = configparser.ConfigParser()
config.read('config.ini')


def generate_html(all_gateways, polling_times, config):
    """
    Generate HTML content using the gateway data and polling times.

    Args:
        all_gateways (dict): Dictionary containing gateway data for all pfSense instances.
        polling_times (dict): Dictionary containing polling times for each pfSense instance.
        config (ConfigParser): Configuration object.

    Returns:
        None
    """
    env = Environment(loader=FileSystemLoader('.'))
    template = env.get_template('gateway_template.html')

    combined_gateways = []
    for pfsense_name, gateways in all_gateways.items():
        for gateway in gateways:
            gateway['pfsense'] = pfsense_name
            gateway['id'] = f"{pfsense_name}_{gateway['name']}"  # Add this line
            combined_gateways.append(gateway)

    sorted_gateways = sorted(combined_gateways, key=lambda x: (x['status_symbol'] == '✅', x['pfsense'], x['name']))

    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    html_content = template.render(
        gateways=sorted_gateways,
        multiple_pfsense=len(all_gateways) > 1,
        current_time=current_time,
        polling_times=polling_times
    )

    output_path = config['General']['html_output']

    with open(output_path, 'w') as f:
        f.write(html_content)

    print(f"HTML output generated: {output_path}")


def get_status_color(status, loss):
    """
    Determine the status color, symbol, and order based on the gateway status and packet loss.

    Args:
        status (str): The status of the gateway.
        loss (str): The packet loss percentage.

    Returns:
        tuple: A tuple containing the color class, status symbol, and status order.
    """
    status_lower = status.lower()
    if 'offline' in status_lower:
        return 'table-danger', '❌', 2
    elif 'packetloss' in status_lower or loss != '0.0%':
        return 'table-warning', '⚠️', 1
    else:
        return 'table-success', '✅', 0


def get_gateway_status(session, pfsense_config):
    """
    Retrieve gateway status from a pfSense using the pfsense integrated gateway.widget.php

    Args:
        session (requests.Session): An authenticated session.
        pfsense_config (dict): Configuration for the pfSense instance.

    Returns:
        str or None: HTML content of the gateway status if successful, None otherwise.
    """
    url = pfsense_config['url']
    gateway_url = f"{url}/widgets/widgets/gateways.widget.php"
    print(f"Fetching gateway status from {gateway_url}")

    csrf_token = get_csrf_token(session, f"{url}/index.php")
    if not csrf_token:
        print("Failed to get CSRF token for gateway status request")
        return None

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Accept': 'text/html, */*; q=0.01',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': url,
        'Referer': f'{url}/index.php',
    }

    data = {
        '__csrf_magic': f'sid:{csrf_token}',
        'ajax': 'ajax',
        'widgetkey': config['Gateways']['widget_key']
    }

    response = session.post(gateway_url, headers=headers, data=data, verify=False)
    print(f"Gateway status response code: {response.status_code}")
    if response.status_code != 200:
        print(f"Error content: {response.text[:500]}")
    return response.text if response.status_code == 200 else None


def parse_gateway_status(html_content):
    """
    Parse the HTML content of the pfsense gateway.widget and
    extract gateway status information. We are intentionally
    not extracting the IP of the Gateways due we do not want
    to display it on the dashboard to avoid leaking of the
    public IP.

    Args:
        html_content (str): HTML content of the gateway status page.

    Returns:
        list: A list of dictionaries containing parsed gateway information.
    """
    soup = BeautifulSoup(html_content, 'html.parser')
    gateways = []
    rows = soup.find_all('tr')
    for row in rows:
        cols = row.find_all('td')
        if len(cols) >= 6:
            name = list(cols[1].descendants)[0].string
            loss = cols[4].text.strip()
            status = cols[5].text.strip()
            color_class, status_symbol, status_order = get_status_color(status, loss)
            gateway = {
                'name': name,
                'delay': cols[2].text.strip(),
                'stddev': cols[3].text.strip(),
                'loss': loss,
                'status': status,  # Keep the original status message
                'status_symbol': status_symbol,
                'color_class': color_class,
                'status_order': status_order  # Add this line
            }
            gateways.append(gateway)
    return gateways


def main(daemon_mode=False):
    """
    Main function to poll pfSense instances and generate the status page.

    Args:
        daemon_mode (bool): Whether to run in daemon mode (continuous polling).

    Returns:
        None
    """
    poll_interval = int(config['General'].get('poll_every', 30))

    if daemon_mode:
        log_message(f"Running in daemon mode. Polling every {poll_interval} seconds.")
    else:
        log_message("Running in single execution mode.")

    while True:
        all_gateways = {}
        polling_times = {}
        pfsense_configs = [section for section in config.sections() if section.startswith('PfSense_')]

        for pfsense_section in pfsense_configs:
            pfsense_config = dict(config[pfsense_section])
            start_time = time.time()

            log_message(f"Polling {pfsense_config['name']}...")

            session = login_pfsense(pfsense_config)
            if not session:
                log_message(f"Authentication failed for {pfsense_config['name']}")
                continue

            html_content = get_gateway_status(session, pfsense_config)
            if not html_content:
                log_message(f"Failed to retrieve gateway status for {pfsense_config['name']}")
                continue

            gateways = parse_gateway_status(html_content)
            if not gateways:
                log_message(f"No gateways found in the parsed content for {pfsense_config['name']}")
            else:
                all_gateways[pfsense_config['name']] = gateways
                log_message(f"Successfully retrieved {len(gateways)} gateways for {pfsense_config['name']}")

            end_time = time.time()
            polling_times[pfsense_config['name']] = round(end_time - start_time, 2)

        if all_gateways:
            log_message("Generating HTML output...")
            generate_html(all_gateways, polling_times, config)
            log_message("HTML output generated successfully.")
        else:
            log_message("No gateway data retrieved from any pfSense instance")

        if not daemon_mode:
            break

        log_message(f"Waiting {poll_interval} seconds before next poll...")
        time.sleep(poll_interval)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="pfSense Gateway Status Poller")
    parser.add_argument("-d", "--daemon", action="store_true", help="Run in daemon mode")
    args = parser.parse_args()

    try:
        main(daemon_mode=args.daemon)
    except KeyboardInterrupt:
        log_message("Script terminated by user.")
    except Exception as e:
        log_message(f"An error occurred: {e}")
