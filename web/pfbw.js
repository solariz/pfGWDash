// Global variables
let lastValueMap = {};
let preventZeroUpdates = true;
// Add a global debug flag that will be set from the data attribute in the HTML template
let DEBUG_ENABLED = false;

/**
 * Conditionally logs debug messages only when DEBUG_ENABLED is true
 */
function debugLog(...args) {
    if (DEBUG_ENABLED) {
        console.log(...args);
    }
}

/**
 * Gets a color based on usage thresholds
 * @param {number} percentage - Value from 0 to 100
 * @return {string} CSS color value
 */
function getColorForPercentage(percentage) {
    // Ensure percentage is between 0 and 100
    percentage = Math.min(100, Math.max(0, percentage));
    
    // Use fixed color thresholds instead of a gradient
    if (percentage < 1) {
        // 0% = neutral color (inactive)
        return 'var(--inactive-color)';
    } else if (percentage <= 50) {
        // 1-50% = green
        return 'var(--success-color,rgb(46, 188, 105))';
    } else if (percentage <= 70) {
        // 51-70% = yellow
        return 'var(--warning-color,rgb(237, 194, 19))';
    } else if (percentage <= 80) {
        // 71-85% = orange
        return 'var(--warning-dark-color,rgb(209, 113, 28))';
    } else if (percentage <= 90) {
        // 71-85% = orange
        return 'var(--warning-dark-color,rgb(163, 57, 45))';
    } else {
        // >85% = red
        return 'var(--danger-color,rgb(255, 0, 0))';
    }
}

/**
 * Updates bandwidth bars based on the current and maximum values (initial load)
 */
function updateBandwidthBars() {
    document.querySelectorAll('.incoming-bar, .outgoing-bar').forEach(bar => {
        const value = parseFloat(bar.dataset.value || '0');
        
        if (value < 0.005) {
            bar.style.width = '0%';
            bar.style.backgroundColor = 'var(--inactive-color)';
            return;
        }
        
        let maxValue = 1;
        const maxAttr = bar.dataset.max;
        if (maxAttr !== null && maxAttr !== undefined && maxAttr !== "") {
            maxValue = parseFloat(maxAttr);
            if (isNaN(maxValue) || maxValue <= 0) maxValue = 1;
        }
        
        let percentage = Math.min((value / maxValue) * 100, 100);
        
        bar.style.width = '0%'; // Start at 0 for animation
        
        // Apply width after initial render, triggering transition
        setTimeout(() => {
            bar.style.transition = 'width 0.8s ease-out, background-color 0.8s ease-out';
            bar.style.width = `${percentage}%`;
            bar.style.backgroundColor = getColorForPercentage(percentage);
        }, 50); 
    });
}

/**
 * Format Mbps values for display
 * @param {number} value - Value in Mbps
 * @return {string} Formatted value with unit
 */
function formatBandwidth(value) {
    if (value >= 1000) {
        return (value / 1000).toFixed(1) + "g";
    } else if (value >= 1) {
        return value.toFixed(0) + "m";
    } else {
        return (value * 1000).toFixed(0) + "k";
    }
}

/**
 * Format time for x-axis
 * @param {number} timestamp - Unix timestamp
 * @return {string} Formatted time (HH:MM)
 */
function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.getHours().toString().padStart(2, '0') + ':' + 
           date.getMinutes().toString().padStart(2, '0');
}

/**
 * Draws a smooth curve through points
 * @param {CanvasRenderingContext2D} ctx - Canvas context
 * @param {Array} points - Array of [x,y] points
 */
function drawCurve(ctx, points) {
    if (points.length < 2) return;
    
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    
    if (points.length === 2) {
        ctx.lineTo(points[1][0], points[1][1]);
    } else {
        for (let i = 1; i < points.length; i++) {
            ctx.lineTo(points[i][0], points[i][1]);
        }
    }
    ctx.stroke();
}

/**
 * Generate nice rounded values for y-axis
 * @param {number} maxValue - Maximum value on the axis
 * @param {number} divisions - Desired number of divisions (approximate)
 * @return {Array} Array of nice values
 */
function getNiceAxisValues(maxValue, divisions) {
    const values = [];
    if (maxValue <= 0) return [0];

    const magnitude = Math.pow(10, Math.floor(Math.log10(maxValue)));
    let stepSize;
    const normalized = maxValue / magnitude;

    if (normalized <= 1.5) stepSize = magnitude / 5;
    else if (normalized <= 3) stepSize = magnitude / 2;
    else if (normalized <= 7) stepSize = magnitude;
    else stepSize = magnitude * 2;

    const actualDivisions = Math.max(1, Math.ceil(maxValue / stepSize));

    for (let i = 0; i <= actualDivisions; i++) {
        const value = i * stepSize;
        if (value <= maxValue * 1.01) { // Add slight buffer
            values.push(value);
        } else {
            break;
        }
    }
    
    // Ensure max value is covered if steps don't quite reach it
    if (values.length === 0 || values[values.length - 1] < maxValue) {
       // values.push(maxValue); // Avoid pushing exact max if step is close
    }
    if (values.length === 0) values.push(0.1); // Avoid empty axis

    return values;
}

/**
 * Draws bandwidth history charts for all interfaces
 */
function drawHistoryCharts() {
    debugLog("Drawing history charts...");
    
    if (!initialBandwidthHistory || !initialBandwidthHistory.interfaces) {
        debugLog("No bandwidth history data available");
        return;
    }

    debugLog("Available interfaces:", Object.keys(initialBandwidthHistory.interfaces));
    const currentTime = initialBandwidthHistory.timestamp || Math.floor(Date.now() / 1000);
    debugLog("Current timestamp:", currentTime, "formatted:", formatTime(currentTime));

    // Get current theme to adjust chart colors
    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid-color');
    const inColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-in-color');
    const outColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-out-color');

    Object.keys(initialBandwidthHistory.interfaces).forEach(interfaceName => {
        const canvas = document.getElementById(`chart-${interfaceName}`);
        if (!canvas) {
            debugLog(`Canvas not found for ${interfaceName}`);
            return;
        }
        
        const container = canvas.closest('.history-container');
        if (!container) {
            debugLog(`Container not found for ${interfaceName}`);
            return;
        }

        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        container.querySelectorAll('.y-axis-label, .x-axis-label').forEach(el => el.remove());
        
        const interfaceData = initialBandwidthHistory.interfaces[interfaceName];
        if (!interfaceData || !interfaceData.in || !interfaceData.out) {
            debugLog(`No data for interface ${interfaceName}`);
            return;
        }

        let maxValue = 0.1;
        interfaceData.in.forEach(p => { if (p && p.length >= 2) maxValue = Math.max(maxValue, p[1]); });
        interfaceData.out.forEach(p => { if (p && p.length >= 2) maxValue = Math.max(maxValue, p[1]); });

        maxValue *= 1.2; // Add headroom

        const padding = { top: 10, right: 15, bottom: 25, left: 35 };
        const chartWidth = canvas.width - padding.left - padding.right;
        const chartHeight = canvas.height - padding.top - padding.bottom;

        if (chartWidth <= 0 || chartHeight <= 0) return;

        // Fill background based on theme
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(padding.left, padding.top, chartWidth, chartHeight);

        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 1;

        const yAxisValues = getNiceAxisValues(maxValue, 3);
        for (let i = 0; i < yAxisValues.length; i++) {
            const value = yAxisValues[i];
            if (typeof value !== 'number' || isNaN(value)) continue;
            const y = padding.top + chartHeight * (1 - value / maxValue);
            if (y < padding.top || y > padding.top + chartHeight) continue;
            
            ctx.beginPath();
            ctx.moveTo(padding.left, y);
            ctx.lineTo(padding.left + chartWidth, y);
            ctx.stroke();
            
            const label = document.createElement('div');
            label.className = 'y-axis-label';
            label.textContent = formatBandwidth(value);
            label.style.top = `${y}px`;
            container.appendChild(label);
        }

        let oldestTimestamp = currentTime;
        interfaceData.in.forEach(p => { if (p && p.length >= 1) oldestTimestamp = Math.min(oldestTimestamp, p[0]); });
        interfaceData.out.forEach(p => { if (p && p.length >= 1) oldestTimestamp = Math.min(oldestTimestamp, p[0]); });

        const timeRange = Math.max(currentTime - oldestTimestamp, 300);
        const xGridLines = 2;
        for (let i = 0; i <= xGridLines; i++) {
            const x = padding.left + chartWidth * (i / xGridLines);
            
            ctx.beginPath();
            ctx.moveTo(x, padding.top);
            ctx.lineTo(x, padding.top + chartHeight);
            ctx.stroke();
            
            const timeOffset = timeRange * (i / xGridLines); 
            const timestamp = currentTime - timeOffset;
            
            const label = document.createElement('div');
            label.className = 'x-axis-label';
            label.textContent = formatTime(timestamp);
            label.style.left = `${x}px`;
            label.style.bottom = '2px';
            container.appendChild(label);
        }

        const pointToCanvas = (point) => {
            if (!point || point.length < 2 || typeof point[0] !== 'number' || typeof point[1] !== 'number' || isNaN(point[1]) || point[1] < 0) return null;
            const timeOffset = currentTime - point[0];
            if (timeOffset > timeRange * 1.1) return null;
            const xRatio = Math.min(Math.max(timeOffset / timeRange, 0), 1);
            const x = padding.left + chartWidth * (1 - xRatio);
            const yRatio = maxValue > 0 ? Math.min(point[1] / maxValue, 1) : 0;
            const y = padding.top + chartHeight * (1 - yRatio);
            return [x, y];
        };

        let inPoints = interfaceData.in.map(pointToCanvas).filter(p => p !== null).sort((a, b) => a[0] - b[0]);
        let outPoints = interfaceData.out.map(pointToCanvas).filter(p => p !== null).sort((a, b) => a[0] - b[0]);

        if (inPoints.length > 1) {
            ctx.strokeStyle = inColor;
            ctx.lineWidth = 2;
            drawCurve(ctx, inPoints);
        }
        if (outPoints.length > 1) {
            ctx.strokeStyle = outColor;
            ctx.lineWidth = 2;
            drawCurve(ctx, outPoints);
        }
    });
}

/**
 * Sets up history sections (initial chart sizing)
 */
function setupHistoryToggles() {
    document.querySelectorAll('.history-section').forEach(section => {
        const interfaceName = section.id.replace('history-', '');
        setTimeout(() => {
            const canvas = document.getElementById(`chart-${interfaceName}`);
            if (canvas) {
                canvas.style.width = "100%";
                canvas.style.height = "100%";
                canvas.width = canvas.offsetWidth;
                canvas.height = canvas.offsetHeight;
                debugLog(`Canvas for ${interfaceName} initialized: ${canvas.width}x${canvas.height}`);
            }
        }, 50);
    });
}

/**
 * AJAX Update Module
 */
const AJAXUpdater = (function() {
    // Note: pollIntervalSeconds is defined globally in the HTML template
    if (typeof pollIntervalSeconds === 'undefined') {
        console.error("pollIntervalSeconds not defined. Check HTML template script.");
        // Provide a fallback or handle the error appropriately
        // For now, let's set a default to prevent crashes, but log an error.
        pollIntervalSeconds = 10; 
    }
    let updateTimer = null;
    let lastSuccessfulUpdateTime = Date.now();
    let isUpdating = false;
    let failedAttempts = 0;
    const MAX_FAILED_ATTEMPTS = 3;
    const STALE_DATA_THRESHOLD_MS = 60 * 1000; // 1 minute
    let lastDataTimestamp = 0; // Actual timestamp from JSON file

    const lastUpdateElement = document.getElementById('last-update-time');
    const staleAlertElement = document.getElementById('stale-data-alert');
    const staleOverlayElement = document.getElementById('stale-data-overlay');

    const currentValues = {}; // Reuse from earlier script if needed, or redefine locally
    
    function fetchUpdatedData() {
        const promises = [
            fetch('pfsense_monitor_data.json?t=' + Date.now(), { cache: 'no-store' })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    return response.json();
                })
                .then(data => {
                    debugLog("DEBUG: Raw monitor data received:", data);
                    return data;
                }),
            fetch('bandwidth_history.json?t=' + Date.now(), { cache: 'no-store' })
                .then(response => {
                    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                    return response.json();
                })
        ];
        return Promise.all(promises)
            .then(([monitorData, historyData]) => ({ monitorData, historyData }))
            .catch(error => {
                 debugLog("Fetch error:", error);
                 throw error;
            });
    }

    function findActiveFirewall(data) {
        let activeFirewall = '';
        let maxTotalBw = -1; // Use -1 to handle cases where all BW is 0
        const firewallNames = Object.keys(data.bandwidth_data || {});

        for (const fwName of firewallNames) {
            const fwData = data.bandwidth_data[fwName] || {};
            let currentFwBw = 0;
            let interfaceCount = 0;
            for (const intfName in fwData) {
                const intf = fwData[intfName];
                if (intf && intf.length >= 2 && intf[0].values && intf[1].values) {
                    // Simple heuristic: count interfaces with data
                    interfaceCount++;
                    // You could calculate actual BW here if needed for accuracy
                }
            }
            // Prioritize firewall with more active interfaces, or just the first one
            if (interfaceCount > maxTotalBw) { 
                maxTotalBw = interfaceCount;
                activeFirewall = fwName;
            }
        }

        if (!activeFirewall && firewallNames.length > 0) {
            activeFirewall = firewallNames[0];
        }
        
        return {
            name: activeFirewall,
            fwNumber: firewallNames.indexOf(activeFirewall) + 1
        };
    }

    function processMonitorData(monitorData) {
        if (!monitorData) {
             debugLog("DEBUG: Invalid monitorData received: null or undefined");
             return { maxBandwidth: {}, interfaceNames: {}, pollingTimes: {} };
        }
        
        // Debug the actual received data
        debugLog("DEBUG: monitorData keys:", Object.keys(monitorData));
        
        // Only extract non-bandwidth data from monitor data
        const maxBandwidth = monitorData.max_bandwidth || {};
        const interfaceNames = monitorData.interface_names || {};
        const pollingTimes = monitorData.polling_times || {};
        
        return {
            maxBandwidth,
            interfaceNames,
            pollingTimes 
        };
    }

    function silentlyUpdateInterfaceValues(processedData, historyData) {
        debugLog("DEBUG: Starting silent update with history data:", historyData);
        debugLog("DEBUG: Current bandwidth history timestamp:", historyData.timestamp);
        
        // DEBUG: Check what's in the history interfaces
        if (historyData && historyData.interfaces) {
            debugLog("DEBUG: Available interfaces in history:", Object.keys(historyData.interfaces));
            
            // Examine one interface in detail as an example
            const sampleInterface = Object.keys(historyData.interfaces)[0];
            if (sampleInterface) {
                const sampleData = historyData.interfaces[sampleInterface];
                debugLog(`DEBUG: Sample interface '${sampleInterface}' data structure:`, {
                    inArrayLength: sampleData.in?.length || 0,
                    outArrayLength: sampleData.out?.length || 0,
                    firstInEntry: sampleData.in?.[0] || 'none',
                    lastInEntry: sampleData.in?.[sampleData.in?.length-1] || 'none',
                    entriesSortedBy: sampleData.in?.length > 1 ? 
                        (sampleData.in[0][0] > sampleData.in[1][0] ? "newest first" : "oldest first") : 
                        "not enough data to tell"
                });
            }
        }
        
        if (!historyData || !historyData.interfaces) {
            debugLog("DEBUG: No valid history data for interface updates");
            return;
        }
        
        const { maxBandwidth } = processedData;
        
        document.querySelectorAll('.interface-card').forEach(card => {
            const displayName = card.dataset.interface;
            if (!displayName) return;

            debugLog(`DEBUG: Processing interface card: ${displayName}`);
            
            // Get the latest bandwidth data from history
            const interfaceHistory = historyData.interfaces[displayName];
            if (!interfaceHistory || !interfaceHistory.in || !interfaceHistory.out || 
                interfaceHistory.in.length === 0 || interfaceHistory.out.length === 0) {
                debugLog(`DEBUG: No history data for interface ${displayName}`);
                return;
            }
            
            debugLog(`DEBUG: Interface ${displayName} history data:`, {
                inLength: interfaceHistory.in.length,
                outLength: interfaceHistory.out.length,
                inFirstEntry: interfaceHistory.in[0],
                outFirstEntry: interfaceHistory.out[0]
            });
            
            // CRITICAL FIX: Make sure we're getting the newest entry
            // Verify sort order - the history should have newest entry first
            const sortedNewestFirst = interfaceHistory.in.length > 1 && 
                                     interfaceHistory.in[0][0] > interfaceHistory.in[1][0];
                                     
            debugLog(`DEBUG: History for ${displayName} is sorted newest first? ${sortedNewestFirst}`);
            
            // Get the index of the newest entry
            const inIndex = sortedNewestFirst ? 0 : interfaceHistory.in.length - 1;
            const outIndex = sortedNewestFirst ? 0 : interfaceHistory.out.length - 1;
            
            // Extract latest values (entries should be [timestamp, value])
            const latestInData = interfaceHistory.in[inIndex];
            const latestOutData = interfaceHistory.out[outIndex];
            
            if (!latestInData || !latestOutData || latestInData.length < 2 || latestOutData.length < 2) {
                debugLog(`DEBUG: Invalid history data format for ${displayName}`);
                return;
            }
            
            // Get the actual latest bandwidth values
            const latestIn = latestInData[1]; // Second element is the value
            const latestOut = latestOutData[1]; // Second element is the value
            const latestTimestamp = Math.max(latestInData[0], latestOutData[0]); // First element is timestamp
            
            debugLog(`DEBUG: Latest history values for ${displayName}: in=${latestIn}, out=${latestOut}, timestamp=${latestTimestamp}`);
            
            // Get current values before updating
            const inBar = card.querySelector('.incoming-bar');
            const outBar = card.querySelector('.outgoing-bar');
            const currentInValue = inBar ? parseFloat(inBar.dataset.value || '0') : 0;
            const currentOutValue = outBar ? parseFloat(outBar.dataset.value || '0') : 0;
            
            debugLog(`DEBUG: ${displayName} current vs new values:`, {
                currentIn: currentInValue,
                newIn: latestIn,
                currentInWidth: inBar ? inBar.style.width : 'none',
                currentOut: currentOutValue,
                newOut: latestOut,
                currentOutWidth: outBar ? outBar.style.width : 'none'
            });
            
            // CRITICAL CHANGE: Only prevent zeros from overwriting non-zeros
            // BUT ensure actual updates happen when values have significantly changed
            const shouldSkipInUpdate = latestIn === 0 && currentInValue > 0;
            const shouldSkipOutUpdate = latestOut === 0 && currentOutValue > 0;
            
            if (shouldSkipInUpdate && shouldSkipOutUpdate) {
                debugLog(`DEBUG: PREVENTING ZERO UPDATE FOR ${displayName}`);
                return;
            }

            // Update text values
            const inValueElem = card.querySelector('[data-metric="in"] .bandwidth-value');
            if (inValueElem && !shouldSkipInUpdate) {
                const currentText = `${latestIn.toFixed(2)} Mbps`;
                if (inValueElem.textContent !== currentText) {
                    debugLog(`DEBUG: Updating IN text for ${displayName} from "${inValueElem.textContent}" to "${currentText}"`);
                    inValueElem.textContent = currentText;
                }
            }
            
            const outValueElem = card.querySelector('[data-metric="out"] .bandwidth-value');
            if (outValueElem && !shouldSkipOutUpdate) {
                const currentText = `${latestOut.toFixed(2)} Mbps`;
                if (outValueElem.textContent !== currentText) {
                    debugLog(`DEBUG: Updating OUT text for ${displayName} from "${outValueElem.textContent}" to "${currentText}"`);
                    outValueElem.textContent = currentText;
                }
            }
            
            // Debug the bandwidth bar updates beforehand
            if (inBar && !shouldSkipInUpdate) {
                debugLog(`DEBUG: About to update ${displayName} IN bar with value ${latestIn}`);
            }
            
            if (outBar && !shouldSkipOutUpdate) {
                debugLog(`DEBUG: About to update ${displayName} OUT bar with value ${latestOut}`);
            }
            
            // Update bandwidth bars unless we're trying to set to zero
            if (!shouldSkipInUpdate) {
                updateBandwidthBarAJAX(card, 'in', latestIn, maxBandwidth);
            }
            
            if (!shouldSkipOutUpdate) {
                updateBandwidthBarAJAX(card, 'out', latestOut, maxBandwidth);
            }
        });
    }
    
    function updateHistoryChartsAJAX(historyData) {
         if (!historyData || !historyData.interfaces) {
             debugLog("AJAX: No history data available for charts");
             return;
         }
         initialBandwidthHistory = historyData; // Update global history object
         drawHistoryCharts(); // Redraw charts with new data
    }

    function checkDataStaleness(monitorData, historyData) {
        const now = Math.floor(Date.now() / 1000); // Current time in seconds
        
        // Get timestamps from JSON data
        const monitorTimestamp = monitorData && monitorData.timestamp ? monitorData.timestamp : 0;
        const historyTimestamp = historyData && historyData.timestamp ? historyData.timestamp : 0;
        
        // Use the most recent timestamp
        const dataTimestamp = Math.max(monitorTimestamp, historyTimestamp);
        lastDataTimestamp = dataTimestamp;
        
        debugLog(`Monitor data timestamp: ${monitorTimestamp}, History data timestamp: ${historyTimestamp}`);
        
        // Calculate time since last data update (in seconds)
        const dataAge = now - dataTimestamp;
        debugLog(`Data age: ${dataAge} seconds`);
        
        // Show stale data alert if data is older than threshold
        const isStale = dataAge > (STALE_DATA_THRESHOLD_MS / 1000);
        if (staleAlertElement && staleOverlayElement) {
            if (isStale) {
                const minutes = Math.floor(dataAge / 60);
                const seconds = dataAge % 60;
                staleAlertElement.textContent = `WARNING: DATA IS OUTDATED\n\nLast update was ${minutes}m ${seconds}s ago.\n\nThe displayed information is not current!`;
                staleAlertElement.style.display = 'block';
                staleOverlayElement.style.display = 'block';
                
                // Also update the status dot to indicate stale data
                const statusDot = document.querySelector('.update-status');
                if (statusDot) {
                    statusDot.style.backgroundColor = 'var(--danger-color, red)';
                    statusDot.style.animation = 'pulse 2s infinite';
                    statusDot.title = 'Data is stale';
                }
            } else {
                staleAlertElement.style.display = 'none';
                staleOverlayElement.style.display = 'none';
                
                // Reset status dot
                const statusDot = document.querySelector('.update-status');
                if (statusDot) {
                    statusDot.style.backgroundColor = 'var(--success-color, green)';
                    statusDot.style.animation = '';
                    statusDot.title = 'Live updates active';
                }
            }
        }
        
        return !isStale;
    }

    function updateStatusDisplay() {
        if (lastUpdateElement) {
            const now = new Date(lastSuccessfulUpdateTime);
            const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
            lastUpdateElement.textContent = `Last updated: ${timeString}`;
        }
        
        // Check if data is stale based on our stored timestamp
        const now = Math.floor(Date.now() / 1000);
        const dataAge = now - lastDataTimestamp;
        const isStale = dataAge > (STALE_DATA_THRESHOLD_MS / 1000);
        
        if (staleAlertElement && staleOverlayElement) {
            if (isStale && lastDataTimestamp > 0) {
                const minutes = Math.floor(dataAge / 60);
                const seconds = dataAge % 60;
                staleAlertElement.textContent = `WARNING: DATA IS OUTDATED\n\nLast update was ${minutes}m ${seconds}s ago.\n\nThe displayed information is not current!`;
                staleAlertElement.style.display = 'block';
                staleOverlayElement.style.display = 'block';
                
                // Change status dot color
                const statusDot = document.querySelector('.update-status');
                if (statusDot) {
                    statusDot.style.backgroundColor = 'var(--danger-color, red)';
                }
            }
        }
    }

    function update() {
        if (isUpdating) return;
        isUpdating = true;
        debugLog("DEBUG: Starting update cycle");

        updateStatusDisplay(); 

        fetchUpdatedData()
            .then(({ monitorData, historyData }) => {
                debugLog("DEBUG: Update received data");
                lastSuccessfulUpdateTime = Date.now();
                failedAttempts = 0;
                
                // Check if the data is actually fresh
                const isDataFresh = checkDataStaleness(monitorData, historyData);
                
                if (!isDataFresh) {
                    debugLog("DEBUG: Data received is stale!");
                }
                
                try {
                    debugLog("DEBUG: Processing monitor data");
                    const processedData = processMonitorData(monitorData);
                    debugLog("DEBUG: Processed data:", processedData);
                    
                    // Check if cards exist before trying to update them
                    const cardsExist = document.querySelector('.interface-card');
                    if (cardsExist) {
                        debugLog("DEBUG: Updating interface cards");
                        requestAnimationFrame(() => {
                            // Use history data for bar/text updates instead of calculated_bandwidth_data
                            silentlyUpdateInterfaceValues(processedData, historyData);
                            
                            if (hasSignificantHistoryChange(initialBandwidthHistory, historyData)) {
                                 setTimeout(() => { updateHistoryChartsAJAX(historyData); }, 50);
                            }
                            
                            const footerPollingTime = document.querySelector('.footer-polling-time');
                            if (footerPollingTime && processedData.pollingTimes) {
                                const pollingTimeValues = Object.values(processedData.pollingTimes);
                                const avgPollingTime = pollingTimeValues.length > 0 
                                    ? (pollingTimeValues.reduce((a,b) => a+b, 0) / pollingTimeValues.length).toFixed(2)
                                    : 'n/a';
                                 footerPollingTime.textContent = `Last polled: ${avgPollingTime} seconds`;
                            }
                            updateStatusDisplay();
                        });
                    } else {
                        updateStatusDisplay(); 
                        debugLog("DEBUG: No interface cards found");
                    }
                } catch (err) {
                    console.error("Error processing updates:", err);
                    failedAttempts++;
                    updateStatusDisplay(); 
                }
            })
            .catch(error => {
                console.error("DEBUG: Fetch error:", error);
                failedAttempts++;
                updateStatusDisplay(); 
                if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
                    console.log("Too many failed attempts, stopping updates");
                    stop(); 
                    if(staleAlertElement && staleOverlayElement) {
                        staleAlertElement.textContent = "Failed to fetch updates. Please check connection or reload.";
                        staleAlertElement.style.display = 'block';
                        staleOverlayElement.style.display = 'block';
                    }
                    return; 
                }
            })
            .finally(() => {
                isUpdating = false;
                if (updateTimer !== null) {
                    updateTimer = setTimeout(update, pollIntervalSeconds * 1000);
                }
            });
    }

    function hasSignificantHistoryChange(oldData, newData) {
        if (!oldData || !newData || !oldData.interfaces || !newData.interfaces) return true;
        if (Math.abs(oldData.timestamp - newData.timestamp) > (pollIntervalSeconds + 5)) return true; // If timestamp drifts too much
        
        const newInterfaces = Object.keys(newData.interfaces);
        if(newInterfaces.length !== Object.keys(oldData.interfaces).length) return true;

        for (const interfaceName of newInterfaces) {
            const oldInterface = oldData.interfaces[interfaceName];
            const newInterface = newData.interfaces[interfaceName];
            if (!oldInterface) return true;
            if (newInterface.in?.length > 0 && oldInterface.in?.length > 0) {
                if (newInterface.in[0][0] !== oldInterface.in[0][0]) return true; // Newest timestamp changed
            }
             if (newInterface.out?.length > 0 && oldInterface.out?.length > 0) {
                if (newInterface.out[0][0] !== oldInterface.out[0][0]) return true; // Newest timestamp changed
            }
        }
        return false;
    }

    function start() {
        if (updateTimer !== null) return; // Already running
        window.ajaxUpdaterStarted = true;
        debugLog(`Starting AJAX updates every ${pollIntervalSeconds} seconds.`);
        updateStatusDisplay();
        updateTimer = setTimeout(update, 1000); // Initial update after 1s

        const footerPollingInfo = document.querySelector('.footer-polling-info');
        if (footerPollingInfo && !footerPollingInfo.querySelector('.update-status')) { // Avoid adding multiple dots
            const statusDot = document.createElement('div');
            statusDot.className = 'update-status';
            Object.assign(statusDot.style, { width: '8px', height: '8px', borderRadius: '50%', backgroundColor: 'var(--success-color)', display: 'inline-block', marginLeft: '8px', transition: 'opacity 0.3s ease' });
            statusDot.title = 'Live updates active';
            footerPollingInfo.appendChild(statusDot);
            
            // Use interval only for status dot and stale check, not the main fetch
            setInterval(() => {
                 if(statusDot) statusDot.style.opacity = isUpdating ? '0.5' : '1';
                 updateStatusDisplay(); // Keep checking stale status
            }, 1000); 
        }

        if (typeof pollIntervalSeconds !== 'undefined' && typeof initialBandwidthHistory !== 'undefined') {
             AJAXUpdater.start();
        } else {
             console.error("Failed to start AJAX updater: Required global variables missing.");
             // Display error to user?
        }
    }

    function stop() {
        if (updateTimer) {
            clearTimeout(updateTimer);
            updateTimer = null;
            debugLog("AJAX updates stopped.");
             const statusDot = document.querySelector('.update-status');
             if(statusDot) statusDot.style.backgroundColor = 'var(--danger-color)'; // Indicate stopped
        }
    }

    return { start, stop };
})();

// Initial setup on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    // Get debug setting from HTML data attribute (will be set by Python template)
    const dataElement = document.getElementById('dashboard-data');
    if (dataElement) {
        DEBUG_ENABLED = dataElement.getAttribute('data-debug') === 'true';
        debugLog("Debug mode:", DEBUG_ENABLED ? "ENABLED" : "DISABLED");
    }

    // This is a critical initialization message, so keep it visible even with debugging off
    console.log("DOM content loaded, initializing...");

    // Check if the initial state is "No Data"
    const noDataMessage = document.querySelector('.no-data-message');

    // Polyfills for older browsers (optional but good practice)
    if (!Element.prototype.matches) {
        Element.prototype.matches = Element.prototype.msMatchesSelector || Element.prototype.webkitMatchesSelector;
    }
    if (window.Element && !Element.prototype.closest) {
        Element.prototype.closest = function(s) {
            var el = this;
            do {
                if (Element.prototype.matches.call(el, s)) return el;
                el = el.parentElement || el.parentNode;
            } while (el !== null && el.nodeType === 1);
            return null;
        };
    }

    // Add :contains polyfill (simplified, use carefully)
    // Consider using data attributes for more robust selections
    // This simple polyfill might have performance implications on large pages
    function querySelectorAllWithContains(selector, context) {
        const baseSelector = selector.replace(/:contains\((.*?)\)/g, '');
        const containsText = (selector.match(/:contains\((.*?)\)/) || [])[1]; // Extract text
        const elements = (context || document).querySelectorAll(baseSelector);
        if (!containsText) return Array.from(elements);
        const cleanText = containsText.replace(/['"`]/g, ''); // Remove quotes
        return Array.from(elements).filter(el => el.textContent.includes(cleanText));
    }
     function querySelectorWithContains(selector, context) {
        return querySelectorAllWithContains(selector, context)[0] || null;
     }
     // Override only if needed and if the basic selector fails
     // Note: Directly overriding querySelector/All can be risky

    // Initial UI setup
    setTimeout(() => {
        if (!noDataMessage) {
            // Only run initial updates if cards are present
            debugLog("Initial data present, running initial UI updates.");
            updateBandwidthBars(); // Initial animation for bars
            setupHistoryToggles(); // Initialize chart canvases
            setTimeout(() => {
                drawHistoryCharts(); // Initial chart draw
            }, 150); // Slightly increased delay for chart draw after bars
        } else {
            debugLog("Initial state is 'No Data', skipping initial UI updates.");
        }

        // Always start the AJAX updater
        if (typeof pollIntervalSeconds !== 'undefined' && typeof initialBandwidthHistory !== 'undefined') {
             AJAXUpdater.start();
        } else {
             console.error("Failed to start AJAX updater: Required global variables missing.");
             // Display error to user?
        }
    }, 100);

    // Add the pulse animation for stale data
    const style = document.createElement('style');
    style.textContent = `
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
    `;
    document.head.appendChild(style);
});

// Fallback refresh timer (can be removed if AJAX is reliable)
// setTimeout(() => {
//     if (!window.ajaxUpdaterStarted) {
//         debugLog("AJAX updater didn't start, falling back to page refresh");
//         window.location.reload();
//     }
// }, (typeof pollIntervalSeconds !== 'undefined' ? pollIntervalSeconds : 10) * 2 * 1000 + 10000); // Extended timeout

/**
 * Updates a single bandwidth bar with a new value
 */
function updateBandwidthBarAJAX(card, direction, value, maxBandwidth) {
    const barSelector = direction === 'in' ? '.incoming-bar' : '.outgoing-bar';
    const bar = card.querySelector(barSelector);
    if (!bar) return;

    // Update data attributes silently
    const oldValue = parseFloat(bar.dataset.value || '0');
    const displayName = card.querySelector('.interface-name')?.textContent.trim();
    if (!displayName) return;
    
    debugLog(`DEBUG: Bar update for ${displayName} ${direction}: current=${oldValue}, new=${value}, width=${bar.style.width}`);
    
    // REMOVE ZERO PREVENTION - it's already handled at the interface level
    // We need to make sure updates actually make it to the DOM
    // if (value === 0 && oldValue > 0) {
    //     debugLog(`DEBUG: PREVENTING ZERO UPDATE for ${displayName} ${direction}`);
    //     return;
    // }
    
    bar.dataset.value = value.toString();
    
    const maxKey = `${displayName}-${direction}`;
    let maxValue = parseFloat(bar.dataset.max || '1');
    if (maxBandwidth && maxBandwidth[maxKey] && maxBandwidth[maxKey] > maxValue) {
        maxValue = maxBandwidth[maxKey];
        bar.dataset.max = maxValue.toString();
        debugLog(`DEBUG: Updated max for ${displayName} ${direction} to ${maxValue}`);
    }
    let percentage = maxValue > 0 ? Math.min((value / maxValue) * 100, 100) : 0;

    // Calculate new styles
    const newWidth = (value < 0.005) ? '0%' : `${percentage}%`;
    const newColor = (value < 0.005) ? 'var(--inactive-color)' : getColorForPercentage(percentage);

    // Apply new styles - FORCE UPDATE even if unchanged to ensure DOM really updates
    debugLog(`DEBUG: Setting ${displayName} ${direction} bar width: "${newWidth}", color: "${newColor}"`);
    bar.style.width = newWidth;
    bar.style.backgroundColor = newColor;
    
    // FORCE REFLOW to ensure style changes are rendered
    void bar.offsetWidth;
}
