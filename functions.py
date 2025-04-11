"""
Shared Functions for pfSense Monitoring Scripts

This module contains shared utility functions used by pfGWDash monitoring scripts
for authentication, session management, and other common operations.

Author: Marco G.
GitHub: https://github.com/solariz/pfGWDash
License: MIT
"""
import requests
import re
import json
import os
from datetime import datetime, timedelta
import urllib3
import configparser

# Disable SSL warnings
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# Load configuration
config = configparser.ConfigParser()
config.read('config.ini')


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