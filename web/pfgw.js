/**
 * Gateway Status Page Functionality
 *
 * This script handles the automatic refresh of the gateway status page,
 * re-initialization of DataTables, custom styling, and warning indicators
 * for stale data.
 */
(function() {
    let lastUpdateTime = new Date().getTime();
    let lastSuccessfulUpdateTime = new Date().getTime();
    let isReloading = false;
    let dataTable;

    function reloadPage() {
        if (isReloading) return;
        isReloading = true;

        fetch(window.location.href)
            .then(response => response.text())
            .then(html => {
                const parser = new DOMParser();
                const newDoc = parser.parseFromString(html, 'text/html');
                const newLastUpdated = newDoc.querySelector('p.text-center.mt-4').textContent;
                const newLastUpdateTime = new Date(newLastUpdated.split(': ')[1]).getTime();

                if (newLastUpdateTime > lastUpdateTime) {
                    updateTableContent(newDoc);
                    lastUpdateTime = newLastUpdateTime;
                    lastSuccessfulUpdateTime = new Date().getTime();
                    console.log('Page content updated');
                } else {
                    console.log('No new data available');
                }
                checkLastUpdateTime();
            })
            .catch(error => {
                console.error('Error fetching page content:', error);
                checkLastUpdateTime();
            })
            .finally(() => {
                isReloading = false;
            });
    }

    function updateTableContent(newDoc) {
        const newTable = newDoc.querySelector('#gatewayTable');
        const currentTable = document.querySelector('#gatewayTable');

        if (newTable && currentTable) {
            // Update table body
            const newRows = newTable.querySelectorAll('tbody tr');
            const currentRows = currentTable.querySelectorAll('tbody tr');

            newRows.forEach((newRow, index) => {
                if (currentRows[index]) {
                    currentRows[index].innerHTML = newRow.innerHTML;
                } else {
                    currentTable.querySelector('tbody').appendChild(newRow.cloneNode(true));
                }
            });

            // Remove extra rows if any
            for (let i = newRows.length; i < currentRows.length; i++) {
                currentRows[i].remove();
            }
        }

        // Update last updated text
        const lastUpdatedElement = document.querySelector('p.text-center.mt-4');
        const newLastUpdatedElement = newDoc.querySelector('p.text-center.mt-4');
        if (lastUpdatedElement && newLastUpdatedElement) {
            lastUpdatedElement.textContent = newLastUpdatedElement.textContent;
        }

        // Update polling times table
        const currentPollingTable = document.querySelector('.mt-4 table');
        const newPollingTable = newDoc.querySelector('.mt-4 table');
        if (currentPollingTable && newPollingTable) {
            currentPollingTable.innerHTML = newPollingTable.innerHTML;
        }

        // Reinitialize DataTable
        if (dataTable) {
            dataTable.destroy();
        }
        initializeDataTable();
        applyCustomStyling();
    }

    function initializeDataTable() {
        dataTable = $('#gatewayTable').DataTable({
            "order": [],
            "pageLength": 25,
            "lengthMenu": [[10, 25, 50, -1], [10, 25, 50, "All"]],
            "columnDefs": [
                {
                    "targets": 1,
                    "type": "html",
                    "orderable": true
                }
            ],
            "stateSave": true,
            "stateDuration": -1,
            "stateSaveCallback": function(settings, data) {
                localStorage.setItem('DataTables_' + settings.sInstance, JSON.stringify(data));
            },
            "stateLoadCallback": function(settings) {
                return JSON.parse(localStorage.getItem('DataTables_' + settings.sInstance));
            }
        });
    }

    function initializeScripts() {
        initializeDataTable();
        applyCustomStyling();

        const lastUpdatedElement = document.querySelector('p.text-center.mt-4');
        if (lastUpdatedElement) {
            const lastUpdatedTime = new Date(lastUpdatedElement.textContent.split(': ')[1]).getTime();
            lastUpdateTime = lastUpdatedTime;
            lastSuccessfulUpdateTime = lastUpdatedTime;
            checkLastUpdateTime();
        }
    }

    function applyCustomStyling() {
        const delayElements = document.querySelectorAll('.delay');
        const stddevElements = document.querySelectorAll('.stddev');

        delayElements.forEach(element => {
            const delay = parseFloat(element.textContent);
            if (delay > 150) {
                element.classList.add('red', 'bold');
            } else if (delay > 100) {
                element.classList.add('deep-red');
            } else if (delay > 30) {
                element.classList.add('orange');
            }
        });

        stddevElements.forEach(element => {
            const stddev = parseFloat(element.textContent);
            if (stddev > 20) {
                element.classList.add('red', 'bold');
            } else if (stddev > 10) {
                element.classList.add('deep-red');
            } else if (stddev > 5) {
                element.classList.add('orange');
            }
        });
    }

    function checkLastUpdateTime() {
        const currentTime = new Date().getTime();
        const timeSinceLastUpdate = currentTime - lastSuccessfulUpdateTime;
        const lastUpdatedElement = document.querySelector('p.text-center.mt-4');
        const headerElement = document.querySelector('h1.mb-4');

        if (timeSinceLastUpdate > 60000) { // 60000 ms = 1 minute
            lastUpdatedElement.style.color = 'red';
            if (!lastUpdatedElement.innerHTML.includes('⚠️')) {
                lastUpdatedElement.innerHTML = '⚠️ ' + lastUpdatedElement.innerHTML;
            }

            if (!headerElement.querySelector('.warning-icon')) {
                const warningSpan = document.createElement('span');
                warningSpan.className = 'warning-icon';
                warningSpan.innerHTML = '⚠️ <small style="font-size: 0.5em;">not refreshed</small> ';
                headerElement.prepend(warningSpan);
            }
        } else {
            lastUpdatedElement.style.color = '';
            lastUpdatedElement.innerHTML = lastUpdatedElement.innerHTML.replace('⚠️ ', '');

            const warningIcon = headerElement.querySelector('.warning-icon');
            if (warningIcon) {
                headerElement.removeChild(warningIcon);
            }
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        initializeScripts();
        setInterval(reloadPage, 30000);
    });
})();
