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

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load configuration
config = configparser.ConfigParser()
config.read('config.ini')


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


def load_auth_data():
    """
    Load authentication data (cookie, sessid) from the auth file defined in config

    Returns:
        dict: A dictionary containing the loaded authentication data.
    """
    auth_file = config['Session']['auth_file']
    if os.path.exists(auth_file):
        with open(auth_file, 'r') as f:
            data = json.load(f)
        for pfsense, auth_info in data.items():
            if 'expiry' in auth_info:
                auth_info['expiry'] = datetime.fromisoformat(auth_info['expiry'])
        return data
    return {}

def save_auth_data(auth_data):
    """
    Save authentication data (cookie, sessid) to the auth file.

    Args:
        auth_data (dict): The authentication data to be saved.

    Returns:
        None
    """
    auth_file = config['Session']['auth_file']
    serializable_data = {}
    for pfsense, auth_info in auth_data.items():
        serializable_data[pfsense] = auth_info.copy()
        if 'expiry' in serializable_data[pfsense]:
            serializable_data[pfsense]['expiry'] = serializable_data[pfsense]['expiry'].isoformat()
    with open(auth_file, 'w') as f:
        json.dump(serializable_data, f)

def get_csrf_token(session, url):
    """
    Retrieve the CSRF token from the given URL.

    Args:
        session (requests.Session): The session object to use for the request.
        url (str): The URL to retrieve the CSRF token from.

    Returns:
        str or None: The CSRF token if found, None otherwise.
    """
    response = session.get(url, verify=False)
    csrf_match = re.search(r'sid:([^"]+)', response.text)
    if csrf_match:
        return csrf_match.group(1)
    return None


def login_pfsense(pfsense_config):
    """
    Authenticate with a pfSense instance.

    Args:
        pfsense_config (dict): Configuration for the pfSense instance.

    Returns:
        requests.Session or None: An authenticated session if successful, None otherwise.
    """
    url = pfsense_config['url']
    username = pfsense_config['username']
    password = pfsense_config['password']
    pfsense_name = pfsense_config['name']

    auth_data = load_auth_data()
    if pfsense_name in auth_data:
        if 'expiry' in auth_data[pfsense_name] and datetime.now() < auth_data[pfsense_name]['expiry']:
            print(f"Using stored authentication data for {pfsense_name}")
            session = requests.Session()
            session.verify = False
            session.cookies.update(auth_data[pfsense_name]['cookies'])
            return session

    print(f"Logging in to {url}")
    session = requests.Session()
    session.verify = False

    csrf_token = get_csrf_token(session, url)
    if not csrf_token:
        print("Failed to find CSRF token")
        return None

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': url,
        'Referer': url,
        'Upgrade-Insecure-Requests': '1',
    }

    login_data = {
        '__csrf_magic': f'sid:{csrf_token}',
        'usernamefld': username,
        'passwordfld': password,
        'login': 'Sign In'
    }

    response = session.post(url, headers=headers, data=login_data, verify=False)
    if 'Dashboard' in response.text:
        print(f"Login successful for {pfsense_name}")
        auth_data[pfsense_name] = {
            'cookies': dict(session.cookies),
            'expiry': datetime.now() + timedelta(hours=int(config['Session']['expiry_hours']))
        }
        save_auth_data(auth_data)
        return session
    else:
        print(f"Login failed for {pfsense_name}")
        return None

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
            name_col = cols[1].text.strip().split('\n')
            name = name_col[0].strip().split('.')[0]  # Remove IP from name
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




def log_message(message):
    """
    Log a message with a timestamp.

    Args:
        message (str): The message to be logged.

    Returns:
        None
    """
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {message}")

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
