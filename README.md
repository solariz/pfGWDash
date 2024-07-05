# pfGWDash
small script to accumlulate data from different pfsense boxes and display as a gateway status dashboard


# pfSense Gateway Status Monitor

This project provides a solution for monitoring the status of gateways across multiple pfSense instances. It polls pfSense devices, retrieves gateway information, and generates a dynamic HTML status page.

## Features

- Monitor multiple pfSense instances
- Retrieve real-time gateway status information
- Generate a responsive HTML status page
- Automatic page refresh via JavaScript
- Visual indicators for gateway status and data freshness
- Daemon mode for continuous polling

## Requirements

- Python 3.6+
- Modern web browser for viewing the status page

## Installation

- Required Python packages:
   ```
   pip install -r requirements.txt
   ```
- Copy the `config.ini.example` file to `config.ini` and edit it with your pfSense details.


## Configuration

Edit the `config.ini` file to set up your pfSense instances and general settings:

```ini
[General]
html_output = /path/to/your/output.html
poll_every = 30

[PfSense_1]
name = PfSense1
url = https://192.168.1.1
username = restricteduser
password = your_password

[PfSense_2]
name = PfSense2
url = https://192.168.2.1
username = restricteduser
password = your_password
```

## Usage

### Single Execution Mode

To run the script once:

```
python pfgw.py
```

### Daemon Mode

To run the script in daemon mode, continuously polling at the interval specified in the config:

```
python pfgw.py --daemon
```

## Output

The script generates an HTML file (specified in `config.ini`) that can be served by a web server. This page will automatically refresh its content every 30 seconds.

## Security Considerations

- Store the `config.ini` file securely, as it contains sensitive information.
- Ensure that the machine running this script has secure access to your pfSense instances.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- This project uses Bootstrap and DataTables for enhanced UI.
