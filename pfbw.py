"""
pfSense Bandwidth Monitor (pfBWDash)

This script polls multiple pfSense instances, retrieves interface bandwidth information,
and generates a dynamic HTML status page.

Usage:
    Single execution: python pfbw.py
    Loop mode: python pfbw.py --daemon
"""
import requests
import json
import time
import argparse
import configparser
from datetime import datetime
from jinja2 import Environment, FileSystemLoader
import urllib3
import os
from bs4 import BeautifulSoup
import os.path

from functions import login_pfsense, get_csrf_token, log_message

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

config = configparser.ConfigParser()
config.read('config.ini')

try:
    html_output_path = config['General']['html_output_bw']
    output_dir = os.path.dirname(html_output_path)
    if not os.path.exists(output_dir):
        os.makedirs(output_dir)
        log_message(f"Created output directory: {output_dir}")
except KeyError:
    log_message("Error: html_output_bw not found in config.ini. Using script directory.", level="ERROR")
    output_dir = os.path.dirname(__file__)
except Exception as e:
    log_message(f"Error creating output directory {output_dir}: {e}", level="ERROR")
    output_dir = os.path.dirname(__file__)

DATA_STORE_FILENAME = "pfsense_monitor_data.json"
HBANDWIDTH_HISTORY_FILENAME = "bandwidth_history.json"
DATA_STORE_FILE = os.path.join(output_dir, DATA_STORE_FILENAME)
HBANDWIDTH_HISTORY_FILE = os.path.join(output_dir, HBANDWIDTH_HISTORY_FILENAME)
log_message(f"Using data store file: {DATA_STORE_FILE}")
log_message(f"Using bandwidth history file: {HBANDWIDTH_HISTORY_FILE}")

previous_data = {}
calculated_bandwidth_data = {}
interface_names = {}
interface_names_last_updated = {} 
real_interfaces = {}
max_bandwidth = {}
polling_times = {}

INTERFACE_REFRESH_INTERVAL = 300
HISTORY_RETENTION_PERIOD = 300


def load_stored_data():
    """Load persistent data (raw counters, names, max rates) from a single JSON file."""
    try:
        if os.path.exists(DATA_STORE_FILE):
            with open(DATA_STORE_FILE, 'r') as f:
                data = json.load(f)
            log_message(f"Loaded data from {DATA_STORE_FILE}")
            
            last_updated = {}
            if 'interface_names_updated' in data:
                for pfsense, timestamp in data['interface_names_updated'].items():
                    last_updated[pfsense] = float(timestamp)
            
            return (
                data.get('raw_bandwidth_data', {}),
                data.get('interface_names', {}),
                last_updated,
                data.get('real_interfaces', {}),
                data.get('max_bandwidth', {})
            )
        else:
            log_message(f"No data store file found at {DATA_STORE_FILE}")
            return {}, {}, {}, {}, {}
    except Exception as e:
        log_message(f"Error loading stored data: {e}")
        return {}, {}, {}, {}, {}


def save_stored_data(raw_bandwidth_data, interface_names, interface_names_last_updated, real_interfaces, max_bandwidth):
    """Save persistent data (raw counters, names, max rates) to a single JSON file."""
    try:
        with open(DATA_STORE_FILE, 'w') as f:
            json.dump({
                'raw_bandwidth_data': raw_bandwidth_data,
                'interface_names': interface_names,
                'interface_names_updated': interface_names_last_updated,
                'real_interfaces': real_interfaces,
                'max_bandwidth': max_bandwidth,
                'polling_times': polling_times,
                'timestamp': int(time.time())
            }, f, indent=2)
        log_message(f"Saved persistent data to {DATA_STORE_FILE}")
    except Exception as e:
        log_message(f"Error saving persistent data: {e}")


def load_bandwidth_history():
    """Load bandwidth history from the history JSON file."""
    default_history = {
        "timestamp": int(time.time()),
        "interval": int(config['General'].get('poll_bw_every', 10)),
        "interfaces": {}
    }
    
    try:
        if os.path.exists(HBANDWIDTH_HISTORY_FILE):
            with open(HBANDWIDTH_HISTORY_FILE, 'r') as f:
                file_content = f.read().strip()
                if not file_content:
                    log_message(f"Empty bandwidth history file found, creating new one")
                    return default_history
                    
                try:
                    data = json.loads(file_content)
                    return data
                except json.JSONDecodeError as e:
                    log_message(f"Error decoding JSON in bandwidth history file: {e}")
                    log_message(f"Recreating bandwidth history file from scratch")
                    backup_file = f"{HBANDWIDTH_HISTORY_FILE}.bak"
                    try:
                        import shutil
                        shutil.copy2(HBANDWIDTH_HISTORY_FILE, backup_file)
                        log_message(f"Corrupted file backed up to {backup_file}")
                    except Exception as backup_error:
                        log_message(f"Failed to backup corrupted file: {backup_error}")
                    return default_history
        else:
            log_message(f"No bandwidth history file found, will create new one")
            return default_history
    except Exception as e:
        log_message(f"Error loading bandwidth history: {e}")
        return default_history


def save_bandwidth_history(history_data):
    """Save bandwidth history to a JSON file."""
    try:
        history_data["timestamp"] = int(time.time())
        
        with open(HBANDWIDTH_HISTORY_FILE, 'w') as f:
            json.dump(history_data, f, separators=(',', ':'))
    except Exception as e:
        log_message(f"Error saving bandwidth history: {e}")


def update_bandwidth_history(all_bandwidth):
    """Update the bandwidth history with the latest measurements and remove old entries."""
    history_data = load_bandwidth_history()
    current_time = int(time.time())
    cutoff_time = current_time - HISTORY_RETENTION_PERIOD
    
    active_firewall = None
    max_total_bw = 0
    
    for pfsense_name, bandwidth_data in all_bandwidth.items():
        total_bw = sum(data.get('in', 0) + data.get('out', 0) 
                      for data in bandwidth_data.values() 
                      if data.get('status') == 'ok')
        
        if total_bw > max_total_bw:
            max_total_bw = total_bw
            active_firewall = pfsense_name
    
    if not active_firewall and all_bandwidth:
        active_firewall = list(all_bandwidth.keys())[0]
    
    if not active_firewall:
        log_message("No active firewall found, skipping history update")
        return
    
    bandwidth_data = all_bandwidth.get(active_firewall, {})
    
    for interface_id, data in bandwidth_data.items():
        if data.get('status') != 'ok':
            continue
        
        display_name = data.get('display_name', interface_id)
        
        if display_name not in history_data["interfaces"]:
            history_data["interfaces"][display_name] = {
                "in": [],
                "out": []
            }
        
        in_value = round(data.get('in', 0), 2)
        out_value = round(data.get('out', 0), 2)
        
        history_data["interfaces"][display_name]["in"].insert(0, [current_time, in_value])
        history_data["interfaces"][display_name]["out"].insert(0, [current_time, out_value])
        
        history_data["interfaces"][display_name]["in"] = [
            entry for entry in history_data["interfaces"][display_name]["in"]
            if entry[0] >= cutoff_time
        ]
        history_data["interfaces"][display_name]["out"] = [
            entry for entry in history_data["interfaces"][display_name]["out"]
            if entry[0] >= cutoff_time
        ]
        
        if len(history_data["interfaces"][display_name]["in"]) > 100:
            history_data["interfaces"][display_name]["in"] = history_data["interfaces"][display_name]["in"][:100]
        if len(history_data["interfaces"][display_name]["out"]) > 100:
            history_data["interfaces"][display_name]["out"] = history_data["interfaces"][display_name]["out"][:100]
    
    save_bandwidth_history(history_data)
    log_message(f"Updated bandwidth history for {len(history_data['interfaces'])} interfaces")


def should_update_interface_names(pfsense_name):
    """Determine if we should update interface names."""
    global interface_names, interface_names_last_updated
    
    common_key = 'any_pfsense'
    
    if common_key not in interface_names_last_updated or not interface_names:
        log_message("No previous interface data, will fetch interface names")
        return True
    
    current_time = time.time()
    last_update = interface_names_last_updated.get(common_key, 0)
    time_since_update = current_time - last_update
    
    if time_since_update > INTERFACE_REFRESH_INTERVAL:
        log_message(f"Interface data is {time_since_update:.1f} seconds old, will refresh")
        return True
    
    log_message(f"Using cached interface names, refreshed {time_since_update:.1f} seconds ago")
    return False


def get_interface_names(session, pfsense_config):
    """Retrieve interface name mappings and real interface names from pfSense interfaces widget."""
    global real_interfaces
    
    url = pfsense_config['url']
    interfaces_url = f"{url}/widgets/widgets/interfaces.widget.php"
    log_message(f"Fetching interface information from {interfaces_url}")

    csrf_token = get_csrf_token(session, f"{url}/index.php")
    if not csrf_token:
        log_message("Failed to get CSRF token for interfaces widget request")
        return {}, {}

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Accept': 'text/html, */*; q=0.01',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': url,
        'Referer': f'{url}/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    }

    data = {
        '__csrf_magic': f'sid:{csrf_token}',
        'widgetkey': 'interfaces-0',
        'ajax': 'ajax'
    }

    response = session.post(interfaces_url, headers=headers, data=data, verify=False)
    log_message(f"Interface information response code: {response.status_code}")
    
    if response.status_code != 200:
        log_message(f"Error content: {response.text[:500]}")
        return {}, {}
    
    try:
        soup = BeautifulSoup(response.text, 'html.parser')
        interface_mapping = {}
        real_interface_mapping = {}
        
        rows = soup.select('tr')
        
        for row in rows:
            interface_link = row.select_one('a[href^="/interfaces.php?if="]')
            if interface_link:
                href = interface_link.get('href')
                interface_id = href.split('=')[1] if '=' in href else None
                
                interface_name = interface_link.text.strip()
                
                title_cell = row.select_one('td[title]')
                if title_cell and title_cell.has_attr('title'):
                    title = title_cell['title']
                    real_interface = title.split(' ')[0] if ' ' in title else title
                    
                    if interface_id and real_interface:
                        real_interface_mapping[interface_id] = real_interface
                        log_message(f"Mapped opt interface {interface_id} to real interface {real_interface}")
                
                if interface_id and interface_name:
                    interface_mapping[interface_id] = interface_name
                    log_message(f"Mapped interface {interface_id} to {interface_name}")
        
        return interface_mapping, real_interface_mapping
    
    except Exception as e:
        log_message(f"Error parsing interface information: {e}")
        return {}, {}


def get_interface_bandwidth(session, pfsense_config):
    """Retrieve interface bandwidth information from pfSense."""
    global real_interfaces
    
    url = pfsense_config['url']
    ifstats_url = f"{url}/ifstats.php"
    log_message(f"Fetching bandwidth stats from {ifstats_url}")

    interfaces_list = config['Bandwidth']['interfaces'].split(',')
    interfaces = '|'.join(interfaces_list)
    
    real_interfaces_list = []
    missing_mappings = False
    for interface_id in interfaces_list:
        if interface_id in real_interfaces:
            real_interfaces_list.append(real_interfaces[interface_id])
        else:
            log_message(f"Warning: No real interface mapping found for {interface_id}")
            missing_mappings = True
    
    if missing_mappings and not real_interfaces_list:
        log_message("No real interface mappings available. Using the original interface list as a fallback.")
        real_interfaces_list = interfaces_list
    
    real_interfaces_str = '|'.join(real_interfaces_list)
    log_message(f"Using interfaces: {interfaces}")
    log_message(f"Using real interfaces: {real_interfaces_str}")

    csrf_token = get_csrf_token(session, f"{url}/index.php")
    if not csrf_token:
        log_message("Failed to get CSRF token for bandwidth request")
        return None

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
        'Accept': 'application/json,*/*',
        'Accept-Language': 'en-US',
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'Origin': url,
        'Referer': f'{url}/',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    }

    data = {
        '__csrf_magic': f'sid:{csrf_token}',
        'if': interfaces,
        'realif': real_interfaces_str
    }

    try:
        response = session.post(ifstats_url, headers=headers, data=data, verify=False)
        log_message(f"Bandwidth stats response code: {response.status_code}")
        
        if response.status_code != 200:
            log_message(f"Error content: {response.text[:500]}")
            return None
        
        try:
            return json.loads(response.text)
        except json.JSONDecodeError:
            log_message(f"Failed to parse JSON response: {response.text[:500]}")
            return None
    except Exception as e:
        log_message(f"Error fetching bandwidth data: {e}")
        return None


def calculate_bandwidth(current_data, pfsense_name):
    """Calculate bandwidth based on current and previous data, handling counter rollovers."""
    global previous_data, max_bandwidth
    
    bandwidth_results = {}
    
    if current_data is None:
        log_message(f"No valid current data for {pfsense_name}")
        return {}
    
    new_interfaces = []
    if pfsense_name in previous_data:
        for interface_name in current_data:
            if interface_name not in previous_data[pfsense_name]:
                new_interfaces.append(interface_name)
                log_message(f"Detected new interface: {interface_name} ({get_display_name(interface_name)})")
    
    if pfsense_name not in previous_data:
        previous_data[pfsense_name] = current_data
        log_message(f"Storing initial data for {pfsense_name} for future bandwidth calculations")
        return {}
    
    prev_data = previous_data[pfsense_name]
    
    for interface_name, interface_data in current_data.items():
        try:
            bandwidth_results[interface_name] = {
                'in': 0, 
                'out': 0, 
                'timestamp': 0,
                'display_name': get_display_name(interface_name)
            }
            
            if interface_name not in prev_data:
                log_message(f"New interface {get_display_name(interface_name)} ({interface_name}) detected, will show bandwidth in next poll")
                bandwidth_results[interface_name]['status'] = 'new_interface'
                continue
            
            if len(interface_data) < 2 or len(prev_data[interface_name]) < 2:
                log_message(f"Incomplete data for interface {interface_name}, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'incomplete_data'
                continue
                
            if 'values' not in interface_data[0] or len(interface_data[0]['values']) < 2:
                log_message(f"Invalid current data format for {interface_name}, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'invalid_format'
                continue
                
            current_timestamp = interface_data[0]['values'][0]
            bandwidth_results[interface_name]['timestamp'] = current_timestamp
            
            if 'values' not in prev_data[interface_name][0] or len(prev_data[interface_name][0]['values']) < 2:
                log_message(f"Invalid previous data format for {interface_name}, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'invalid_format'
                continue
                
            prev_timestamp = prev_data[interface_name][0]['values'][0]
            
            time_diff = current_timestamp - prev_timestamp
            
            if time_diff <= 0:
                log_message(f"Invalid time difference for {interface_name}: {time_diff} seconds, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'invalid_time'
                continue
            
            # Assume 64-bit counters for rollover calculation
            COUNTER_MAX = 2**64 
            MAX_REASONABLE_MBPS = 20000 # 20 Gbps sanity check

            current_in = interface_data[0]['values'][1]
            prev_in = prev_data[interface_name][0]['values'][1]
            
            if current_in is None or prev_in is None:
                log_message(f"Missing in-bandwidth values for {interface_name}, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'missing_values'
                continue

            # Handle counter rollover for incoming bytes
            if current_in < prev_in:
                log_message(f"Detected counter rollover for IN traffic on {interface_name} (prev: {prev_in}, curr: {current_in})", level="DEBUG")
                bytes_diff_in = (COUNTER_MAX - prev_in) + current_in
            else:
                bytes_diff_in = current_in - prev_in
                
            megabits_in = (bytes_diff_in * 8) / (time_diff * 1000000)
            
            # Sanity check for incoming bandwidth
            if megabits_in > MAX_REASONABLE_MBPS:
                 log_message(f"Warning: Implausibly high incoming bandwidth calculated for {interface_name}: {megabits_in:.2f} Mbps", level="WARNING")

            bandwidth_results[interface_name]['in'] = megabits_in
            
            current_out = interface_data[1]['values'][1]
            prev_out = prev_data[interface_name][1]['values'][1]
            
            if current_out is None or prev_out is None:
                log_message(f"Missing out-bandwidth values for {interface_name}, skipping calculation")
                bandwidth_results[interface_name]['status'] = 'missing_values'
                continue

            # Handle counter rollover for outgoing bytes
            if current_out < prev_out:
                log_message(f"Detected counter rollover for OUT traffic on {interface_name} (prev: {prev_out}, curr: {current_out})", level="DEBUG")
                bytes_diff_out = (COUNTER_MAX - prev_out) + current_out
            else:
                bytes_diff_out = current_out - prev_out
                
            megabits_out = (bytes_diff_out * 8) / (time_diff * 1000000)

            # Sanity check for outgoing bandwidth
            if megabits_out > MAX_REASONABLE_MBPS:
                 log_message(f"Warning: Implausibly high outgoing bandwidth calculated for {interface_name}: {megabits_out:.2f} Mbps", level="WARNING")

            bandwidth_results[interface_name]['out'] = megabits_out
            bandwidth_results[interface_name]['status'] = 'ok'
            
            interface_display_name = get_display_name(interface_name)
            in_key = f"{interface_display_name}-in"
            out_key = f"{interface_display_name}-out"
            
            if in_key not in max_bandwidth or megabits_in > max_bandwidth[in_key]:
                max_bandwidth[in_key] = megabits_in
                log_message(f"New max incoming bandwidth for {interface_display_name}: {megabits_in:.2f} Mbps")
            
            if out_key not in max_bandwidth or megabits_out > max_bandwidth[out_key]:
                max_bandwidth[out_key] = megabits_out
                log_message(f"New max outgoing bandwidth for {interface_display_name}: {megabits_out:.2f} Mbps")
            
            log_message(f"Calculated bandwidth for {bandwidth_results[interface_name]['display_name']} ({interface_name}): IN={megabits_in:.2f} Mbps, OUT={megabits_out:.2f} Mbps")
        except Exception as e:
            log_message(f"Error calculating bandwidth for {interface_name}: {e}")
            bandwidth_results[interface_name]['status'] = 'error'
            continue
    
    previous_data[pfsense_name] = current_data
    
    return bandwidth_results


def get_display_name(interface_id):
    """Get the human-readable name for an interface ID."""
    global interface_names
    
    if interface_id in interface_names:
        return interface_names[interface_id]
    return interface_id


def generate_html(all_calculated_bw_this_cycle, polling_times):
    """Generate HTML content using the latest history data and polling times."""
    global max_bandwidth
    
    env = Environment(loader=FileSystemLoader('.'))
    template = env.get_template('bandwidth_template.html')
    
    poll_bw_interval = int(config['Bandwidth'].get('poll_every', 30))
    debug_enabled = config['General'].get('debug', 'False').lower() == 'true'
    
    # Get the ordered list of interfaces from config
    ordered_interfaces = [iface.strip() for iface in config['Bandwidth']['interfaces'].split(',')]
    
    # Load the complete history
    bandwidth_history = load_bandwidth_history()
    bandwidth_history["current_time"] = int(time.time())

    # Prepare the latest bandwidth data from history for direct display
    latest_bandwidth_from_history = {}
    if "interfaces" in bandwidth_history:
        for display_name, history in bandwidth_history["interfaces"].items():
            latest_in = history["in"][0][1] if history.get("in") else 0
            latest_out = history["out"][0][1] if history.get("out") else 0
            latest_timestamp = 0
            if history.get("in"):
                latest_timestamp = max(latest_timestamp, history["in"][0][0])
            if history.get("out"):
                latest_timestamp = max(latest_timestamp, history["out"][0][0])
                
            latest_bandwidth_from_history[display_name] = {
                'in': latest_in,
                'out': latest_out,
                'timestamp': latest_timestamp # Add timestamp if needed by template
            }
    
    # Get a mapping of interface IDs to their display names for ordering
    interface_id_to_display = {}
    for firewall_data in all_calculated_bw_this_cycle.values():
        for interface_id, data in firewall_data.items():
            if 'display_name' in data:
                interface_id_to_display[interface_id] = data['display_name']
    
    # Note: The template 'bandwidth_template.html' will need modification.
    # It should iterate using 'all_calculated_bw_this_cycle' to get firewall/interface structure,
    # but use 'latest_bandwidth_from_history[data.display_name]' to get the 'in' and 'out' values for display.
    html_content = template.render(
        all_bandwidth=all_calculated_bw_this_cycle, # Still useful for structure and status
        latest_bandwidth=latest_bandwidth_from_history, # Use this for current values
        polling_times=polling_times,
        current_time=datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        poll_interval=poll_bw_interval,
        max_bandwidth=max_bandwidth,
        bandwidth_history=bandwidth_history, # Full history for graphs
        debug_enabled=debug_enabled, # Pass debug setting to template
        ordered_interfaces=ordered_interfaces, # Pass ordered interface list
        interface_id_to_display=interface_id_to_display # Pass mapping of IDs to display names
    )
    
    output_path = config['General']['html_output_bw']
    with open(output_path, 'w') as f:
        f.write(html_content)
        
    log_message(f"HTML bandwidth output generated: {output_path}")


def main(daemon_mode=False):
    """Main function to poll pfSense instances and generate the bandwidth status page."""
    global previous_data, interface_names, interface_names_last_updated, real_interfaces, max_bandwidth, polling_times
    
    previous_data, interface_names, interface_names_last_updated, real_interfaces, max_bandwidth = load_stored_data()
    
    poll_bw_interval = int(config['General'].get('poll_bw_every', 10))

    if daemon_mode:
        log_message(f"Running in daemon mode. Polling bandwidth every {poll_bw_interval} seconds.")
    else:
        log_message("Running in single execution mode.")

    interface_names_fetched = False
    polling_times = {}
    
    while True:
        current_calculated_bandwidth = {}
        current_polling_times = {} 
        pfsense_configs = [section for section in config.sections() if section.startswith('PfSense_')]
        
        # Track failed firewalls to log summary at the end
        failed_firewalls = []

        for pfsense_section in pfsense_configs:
            try:
                pfsense_config = dict(config[pfsense_section])
                start_time = time.time()

                log_message(f"Polling {pfsense_config['name']}...")

                # Wrap the entire firewall polling process in try/except to handle connection errors
                try:
                    session = login_pfsense(pfsense_config)
                    if not session:
                        log_message(f"Authentication failed for {pfsense_config['name']}")
                        failed_firewalls.append(pfsense_config['name'])
                        continue
                        
                    if not interface_names_fetched and should_update_interface_names('any_pfsense'):
                        try:
                            name_mappings, real_if_mappings = get_interface_names(session, pfsense_config)
                            if name_mappings:
                                interface_names.update(name_mappings)
                                real_interfaces.update(real_if_mappings)
                                current_time = time.time()
                                interface_names_last_updated['any_pfsense'] = current_time
                                log_message(f"Retrieved {len(name_mappings)} interface names and {len(real_if_mappings)} real interface mappings from {pfsense_config['name']}")
                                save_stored_data(previous_data, interface_names, interface_names_last_updated, real_interfaces, max_bandwidth)
                                interface_names_fetched = True
                        except Exception as e:
                            log_message(f"Error getting interface names from {pfsense_config['name']}: {e}", level="WARNING")
                            # Continue anyway, we'll try with next firewall or use existing names

                    try:
                        raw_data = get_interface_bandwidth(session, pfsense_config)
                        if not raw_data:
                            log_message(f"Failed to retrieve bandwidth data for {pfsense_config['name']}")
                            continue

                        calculated_bw = calculate_bandwidth(raw_data, pfsense_config['name'])
                        
                        current_calculated_bandwidth[pfsense_config['name']] = calculated_bw

                        end_time = time.time()
                        current_polling_times[pfsense_config['name']] = round(end_time - start_time, 2)
                    except Exception as e:
                        log_message(f"Error getting bandwidth data from {pfsense_config['name']}: {e}", level="WARNING")
                        # Continue with next firewall
                
                except (requests.exceptions.ConnectionError, 
                        requests.exceptions.Timeout, 
                        requests.exceptions.HTTPError,
                        urllib3.exceptions.MaxRetryError,
                        urllib3.exceptions.NewConnectionError) as conn_error:
                    log_message(f"Connection error to {pfsense_config['name']}: {conn_error}", level="WARNING")
                    failed_firewalls.append(pfsense_config['name'])
                    continue
                except Exception as e:
                    log_message(f"Unexpected error polling {pfsense_config['name']}: {e}", level="ERROR")
                    failed_firewalls.append(pfsense_config['name'])
                    continue
            
            except Exception as e:
                log_message(f"Error processing firewall section {pfsense_section}: {e}", level="ERROR")
                continue

        # Log summary of failed firewalls
        if failed_firewalls:
            log_message(f"Failed to connect to {len(failed_firewalls)} firewall(s): {', '.join(failed_firewalls)}", level="WARNING")
            log_message(f"Continuing with {len(current_calculated_bandwidth)} reachable firewall(s)")

        all_calculated_bw_this_cycle = current_calculated_bandwidth
        polling_times = current_polling_times # Update global polling_times if needed, or manage locally

        # Continue even if some firewalls failed as long as we have data from at least one
        if all_calculated_bw_this_cycle:
            update_bandwidth_history(all_calculated_bw_this_cycle)

        save_stored_data(previous_data, interface_names, interface_names_last_updated, real_interfaces, max_bandwidth)
        
        try:
            generate_html(all_calculated_bw_this_cycle, polling_times)
            log_message("HTML output generated successfully.")
        except Exception as e:
            log_message(f"Error generating HTML output: {e}", level="ERROR")

        if not daemon_mode:
            break

        log_message(f"Waiting {poll_bw_interval} seconds before next poll...")
        time.sleep(poll_bw_interval)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="pfSense Bandwidth Monitor")
    parser.add_argument("-d", "--daemon", action="store_true", help="Run in daemon mode")
    args = parser.parse_args()

    try:
        main(daemon_mode=args.daemon)
    except KeyboardInterrupt:
        log_message("Script terminated by user.")
    except Exception as e:
        log_message(f"An error occurred: {e}")
