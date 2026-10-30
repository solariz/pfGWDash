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

    function parseTimestamp(value) {
        if (!value) return NaN;
        return new Date(value.trim().replace(' ', 'T')).getTime();
    }

    function reloadPage() {
        if (isReloading) return;
        isReloading = true;

        fetch(window.location.href)
            .then(response => response.text())
            .then(html => {
                const parser = new DOMParser();
                const newDoc = parser.parseFromString(html, 'text/html');
                const newLastUpdated = newDoc.querySelector('#lastUpdated');
                const newLastUpdateTime = newLastUpdated ? parseTimestamp(newLastUpdated.textContent) : NaN;

                if (Number.isFinite(newLastUpdateTime) && newLastUpdateTime > lastUpdateTime) {
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
        const lastUpdatedElement = document.querySelector('#lastUpdated');
        const newLastUpdatedElement = newDoc.querySelector('#lastUpdated');
        if (lastUpdatedElement && newLastUpdatedElement) {
            lastUpdatedElement.textContent = newLastUpdatedElement.textContent;
        }

        // Update polling times table
        const currentPollingTable = document.querySelector('#pollingTable');
        const newPollingTable = newDoc.querySelector('#pollingTable');
        if (currentPollingTable && newPollingTable) {
            currentPollingTable.innerHTML = newPollingTable.innerHTML;
        }

        // Reinitialize DataTable
        if (dataTable) {
            dataTable.destroy();
        }
        initializeDataTable();
        dataTable.order([2, 'asc']).draw(); // Re-apply custom sorting
        applyCustomStyling();
    }

    function statusSortingFunction(data) {
        return String(data).includes('✅') ? 1 : 0;
    }

    function initializeDataTable() {
        dataTable = $('#gatewayTable').DataTable({
            "dom": '<"table-scroll"t><"dt-footer"<"dt-footer-left"lf><"dt-footer-right"ip>>',
            "language": {
                "lengthMenu": "Show _MENU_",
                "search": "Search:",
                "searchPlaceholder": "Filter gateways...",
                "info": "Showing _START_ - _END_ of _TOTAL_",
                "infoEmpty": "No gateways",
                "infoFiltered": "(filtered from _MAX_)",
                "zeroRecords": "No matching gateways"
            },
            "order": [],
            "pageLength": 15,
            "lengthMenu": [[10, 15, 40, -1], [10, 15, 40, "All"]],
            "columnDefs": [
                {
                    "targets": 2, // Assuming the Status column is the third column (index 2)
                    "orderable": false,
                    "type": "status",
                    "render": function(data, type, row) {
                        if (type === 'sort') {
                            return statusSortingFunction(data);
                        }
                        return data;
                    },
                    "className": "status-column" // Add this line
                }
            ],
            "stateSave": true,
            "stateDuration": -1,
            "stateSaveCallback": function(settings, data) {
                localStorage.setItem('DataTables_' + settings.sInstance, JSON.stringify(data));
            },
            "stateLoadCallback": function(settings) {
                return JSON.parse(localStorage.getItem('DataTables_' + settings.sInstance));
            },
            "rowGroup": {
                dataSrc: function(row) {
                    return row[2] !== '✅' ? 'Critical' : 'Normal'; // Group by status
                },
                startRender: null // Don't render group headers
            },
            "orderFixed": [
                [2, 'asc'] // Always sort by status first
            ],
            "drawCallback": function(settings) {
                // Remove sort indicators from the Status column
                $(settings.nTableWrapper).find('.status-column').removeClass('sorting sorting_asc sorting_desc');

                // Hide the pager when all rows fit on a single page
                if (settings.api) {
                    const pageInfo = settings.api.page.info();
                    $(settings.nTableWrapper).find('.dataTables_paginate').toggle(pageInfo.pages > 1);
                }
            }
        });
    }


    function initializeScripts() {
        initializeDataTable();
        applyCustomStyling();

        const lastUpdatedElement = document.querySelector('#lastUpdated');
        if (lastUpdatedElement) {
            const lastUpdatedTime = parseTimestamp(lastUpdatedElement.textContent);
            lastUpdateTime = Number.isFinite(lastUpdatedTime) ? lastUpdatedTime : Date.now();
            lastSuccessfulUpdateTime = lastUpdateTime;
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
        const lastUpdatedElement = document.querySelector('#lastUpdated');
        const staleIndicator = document.querySelector('#staleIndicator');

        if (!lastUpdatedElement) {
            return;
        }

        const isStale = timeSinceLastUpdate > 60000; // 60000 ms = 1 minute
        lastUpdatedElement.classList.toggle('is-stale', isStale);

        if (staleIndicator) {
            staleIndicator.hidden = !isStale;
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        initializeScripts();
        setInterval(reloadPage, 4500);
    });
})();
