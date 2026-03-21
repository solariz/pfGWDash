// Global variables
let lastValueMap = {};
let preventZeroUpdates = true;
// Add a global debug flag that will be set from the data attribute in the HTML template
let DEBUG_ENABLED = false;

/** requestAnimationFrame id for continuous history chart redraw */
let historyChartRafId = null;

/** Per-interface latest-point blend state for in/out series (GNOME-style smooth head) */
const historyChartAnimationByInterface = {};

/** Single ResizeObserver for interface card title reflow */
let interfaceTitleResizeObserver = null;

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
 * Smoothstep easing for value interpolation between polls
 * @param {number} t - Linear blend factor in [0, 1]
 * @return {number} Smoothed factor in [0, 1]
 */
function smoothstep(t) {
    const x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
}

/**
 * Sample interval in seconds from history JSON or template poll rate
 * @param {*} historyData - Bandwidth history object (may include interval)
 * @return {number}
 */
function getHistorySampleIntervalSec(historyData) {
    const fallback = typeof pollIntervalSeconds !== 'undefined' ? pollIntervalSeconds : 10;
    if (!historyData || typeof historyData.interval !== 'number' || !isFinite(historyData.interval) || historyData.interval <= 0) {
        return fallback;
    }
    return historyData.interval;
}

/**
 * History sample interval in milliseconds
 * @param {*} historyData
 * @return {number}
 */
function getHistorySampleIntervalMs(historyData) {
    return getHistorySampleIntervalSec(historyData) * 1000;
}

/**
 * Finds the sample with the greatest timestamp in a history series
 * @param {Array} series - Array of [unixSec, value]
 * @return {Array|null} Latest point or null
 */
function getLatestHistoryPoint(series) {
    if (!series || series.length === 0) return null;
    let best = null;
    for (let i = 0; i < series.length; i++) {
        const p = series[i];
        if (!p || p.length < 2 || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue;
        if (!best || p[0] > best[0]) best = p;
    }
    return best;
}

/**
 * Current displayed value for a series head from blend state
 * @param {{initialized:boolean,prev:number,target:number,lastFetchMs:number}} state
 * @param {number} nowMs - performance.now()
 * @return {number}
 */
function getDisplayedSeriesValue(state, nowMs) {
    if (!state || !state.initialized) return 0;
    const hist = typeof initialBandwidthHistory !== 'undefined' ? initialBandwidthHistory : {};
    const intervalMs = getHistorySampleIntervalMs(hist);
    if (intervalMs <= 0) return state.target;
    let t = Math.min(1, (nowMs - state.lastFetchMs) / intervalMs);
    t = smoothstep(t);
    return state.prev + (state.target - state.prev) * t;
}

/**
 * Advances blend state when new server data arrives (prev = last displayed, target = new sample)
 * @param {{initialized:boolean,prev:number,target:number,lastFetchMs:number}|undefined} prevState
 * @param {number} newTargetValue
 * @param {number} nowMs
 * @return {{initialized:boolean,prev:number,target:number,lastFetchMs:number}}
 */
function advanceSeriesAnimState(prevState, newTargetValue, nowMs) {
    if (!prevState || !prevState.initialized) {
        return { initialized: true, prev: newTargetValue, target: newTargetValue, lastFetchMs: nowMs };
    }
    const hist = typeof initialBandwidthHistory !== 'undefined' ? initialBandwidthHistory : {};
    const intervalMs = getHistorySampleIntervalMs(hist);
    if (intervalMs <= 0) {
        return { initialized: true, prev: newTargetValue, target: newTargetValue, lastFetchMs: nowMs };
    }
    let t = Math.min(1, (nowMs - prevState.lastFetchMs) / intervalMs);
    t = smoothstep(t);
    const displayed = prevState.prev + (prevState.target - prevState.prev) * t;
    return { initialized: true, prev: displayed, target: newTargetValue, lastFetchMs: nowMs };
}

/**
 * Initializes animation entries for interfaces that do not have state yet (first paint)
 * @param {*} historyData - Same shape as initialBandwidthHistory
 */
function seedHistoryChartAnimationIfNeeded(historyData) {
    if (!historyData || !historyData.interfaces) return;
    const nowMs = performance.now();
    Object.keys(historyData.interfaces).forEach(name => {
        if (historyChartAnimationByInterface[name]) return;
        const iface = historyData.interfaces[name];
        if (!iface || !iface.in || !iface.out) return;
        const inPt = getLatestHistoryPoint(iface.in);
        const outPt = getLatestHistoryPoint(iface.out);
        const inV = inPt ? inPt[1] : 0;
        const outV = outPt ? outPt[1] : 0;
        const tLatest = Math.max(inPt ? inPt[0] : 0, outPt ? outPt[0] : 0);
        historyChartAnimationByInterface[name] = {
            in: { initialized: true, prev: inV, target: inV, lastFetchMs: nowMs },
            out: { initialized: true, prev: outV, target: outV, lastFetchMs: nowMs },
            lastSampleUnixSec: tLatest > 0 ? tLatest : Math.floor(Date.now() / 1000),
            lastPayloadApplyPerfMs: nowMs
        };
    });
}

/**
 * Keeps a stable Y-axis ceiling: snaps up to new data peaks, eases down slowly to avoid grid/line flicker
 * @param {{axisMaxSmoothed?: number, in: object, out: object}|undefined} entry - Per-interface animation state
 * @param {number} targetMax - Scale top from current samples (includes headroom)
 * @return {number} Maximum Mbps for axis mapping this frame
 */
function getSmoothedAxisMaxForInterface(entry, targetMax) {
    const t = Math.max(0.1, targetMax);
    if (!entry) return t;
    if (typeof entry.axisMaxSmoothed !== 'number' || !isFinite(entry.axisMaxSmoothed)) {
        entry.axisMaxSmoothed = t;
        return t;
    }
    const cur = entry.axisMaxSmoothed;
    const next = cur + (t - cur) * 0.12;
    entry.axisMaxSmoothed = Math.max(next, t);
    return entry.axisMaxSmoothed;
}

/**
 * Removes legacy absolutely-positioned axis divs from older builds (once, not per animation frame)
 */
function removeLegacyHistoryAxisLabels() {
    document.querySelectorAll('.history-container .y-axis-label, .history-container .x-axis-label').forEach(el => el.remove());
}

/**
 * Updates per-series blend state after a new history payload from the server
 * @param {*} historyData
 */
function syncHistoryChartAnimationOnNewPayload(historyData) {
    if (!historyData || !historyData.interfaces) return;
    const nowMs = performance.now();
    Object.keys(historyData.interfaces).forEach(name => {
        const iface = historyData.interfaces[name];
        if (!iface || !iface.in || !iface.out) return;
        const inPt = getLatestHistoryPoint(iface.in);
        const outPt = getLatestHistoryPoint(iface.out);
        const inV = inPt ? inPt[1] : 0;
        const outV = outPt ? outPt[1] : 0;
        const tLatest = Math.max(inPt ? inPt[0] : 0, outPt ? outPt[0] : 0) || Math.floor(Date.now() / 1000);
        let entry = historyChartAnimationByInterface[name];
        if (!entry) {
            historyChartAnimationByInterface[name] = {
                in: { initialized: true, prev: inV, target: inV, lastFetchMs: nowMs },
                out: { initialized: true, prev: outV, target: outV, lastFetchMs: nowMs },
                lastSampleUnixSec: tLatest,
                lastPayloadApplyPerfMs: nowMs
            };
        } else {
            entry.in = advanceSeriesAnimState(entry.in, inV, nowMs);
            entry.out = advanceSeriesAnimState(entry.out, outV, nowMs);
            entry.lastSampleUnixSec = tLatest;
        }
    });
}

/**
 * Scales interface title font so text fits the flex area without overflowing
 * @param {HTMLElement} nameEl - Element with class interface-name
 */
function fitInterfaceNameToHeader(nameEl) {
    if (!nameEl) return;
    const header = nameEl.closest('.interface-card-header');
    if (!header) return;
    nameEl.style.fontSize = '';
    const computedMax = parseFloat(getComputedStyle(nameEl).fontSize);
    const maxPx = computedMax > 0 ? computedMax : 16;
    const minPx = 10;
    nameEl.style.fontSize = `${maxPx}px`;
    if (nameEl.scrollWidth <= nameEl.clientWidth) {
        nameEl.style.fontSize = '';
        return;
    }
    let low = minPx;
    let high = maxPx;
    while (high - low > 0.5) {
        const mid = (low + high) / 2;
        nameEl.style.fontSize = `${mid}px`;
        if (nameEl.scrollWidth <= nameEl.clientWidth) {
            high = mid;
        } else {
            low = mid;
        }
    }
    nameEl.style.fontSize = `${Math.max(minPx, high)}px`;
}

/**
 * Watches interface cards for resize and refits titles
 */
function setupInterfaceTitleResizeObservers() {
    if (typeof ResizeObserver === 'undefined') {
        refitAllInterfaceCardTitles();
        window.addEventListener('resize', refitAllInterfaceCardTitles);
        return;
    }
    if (interfaceTitleResizeObserver) {
        interfaceTitleResizeObserver.disconnect();
    }
    interfaceTitleResizeObserver = new ResizeObserver(() => {
        refitAllInterfaceCardTitles();
    });
    document.querySelectorAll('.interface-card').forEach(card => {
        interfaceTitleResizeObserver.observe(card);
    });
}

/**
 * Refits all interface name elements on the page
 */
function refitAllInterfaceCardTitles() {
    document.querySelectorAll('.interface-card .interface-name').forEach(fitInterfaceNameToHeader);
}

/**
 * Draws in or out series as a polyline with a horizontal tail to the chart right edge
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<Array<number>>} points - [x,y] canvas coords sorted by x ascending
 * @param {number} rightEdgeX
 */
function drawSeriesWithTrailingEdge(ctx, points, rightEdgeX) {
    if (!points || points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i][0], points[i][1]);
    }
    const last = points[points.length - 1];
    ctx.lineTo(rightEdgeX, last[1]);
    ctx.stroke();
}

/**
 * Catmull-Rom style smooth stroke through points, then horizontal tail to the right edge
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<Array<number>>} points - [x,y] sorted by x ascending
 * @param {number} rightEdgeX
 */
function drawSeriesSplineWithTrailingEdge(ctx, points, rightEdgeX) {
    if (!points || points.length === 0) return;
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    if (points.length === 1) {
        ctx.lineTo(rightEdgeX, points[0][1]);
        ctx.stroke();
        return;
    }
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[Math.min(points.length - 1, i + 2)];
        const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
        const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
        const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
        const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2[0], p2[1]);
    }
    const last = points[points.length - 1];
    ctx.lineTo(rightEdgeX, last[1]);
    ctx.stroke();
}

/**
 * Whether Catmull-Rom spline stroke is used for history lines (persisted)
 * @return {boolean}
 */
function isSmoothHistoryChartStrokeEnabled() {
    try {
        return localStorage.getItem('pfbw_smooth_history') === '1';
    } catch (e) {
        return false;
    }
}

/**
 * Binds footer checkbox to smooth-history localStorage and restores saved value
 */
function setupSmoothHistoryChartToggle() {
    const cb = document.getElementById('smooth-history-chart');
    if (!cb) return;
    try {
        cb.checked = localStorage.getItem('pfbw_smooth_history') === '1';
    } catch (e) {
        cb.checked = false;
    }
    cb.addEventListener('change', () => {
        try {
            localStorage.setItem('pfbw_smooth_history', cb.checked ? '1' : '0');
        } catch (err) {
            /* ignore quota / private mode */
        }
    });
}

/**
 * Maps a history series to canvas points using wall-clock time for continuous smooth scrolling.
 * x = rightChartX - (nowSec - point.t) / sampleIntervalSec * pixelsPerSample
 * @param {Array} series - [unixSec, value] samples
 * @param {number|null} maxT - Timestamp of latest sample (for animated Y blend)
 * @param {number} displayV - Smoothstep-interpolated Y value at the head
 * @param {number} nowSec - Current wall-clock time (Date.now()/1000), the right-edge anchor
 * @param {number} windowSec - Visible time span in seconds
 * @param {number} pixelsPerSample - chartWidth * sampleIntervalSec / windowSec
 * @param {number} sampleIntervalSec - Data poll interval in seconds
 * @param {number} rightChartX - Canvas x of the chart right edge
 * @param {number} maxValueDraw - Y-axis ceiling for this frame
 * @param {number} chartTop - Canvas y of the chart top edge
 * @param {number} chartHeight - Chart height in pixels
 * @return {Array<Array<number>>}
 */
function mapHistorySeriesToCanvasPoints(series, maxT, displayV, nowSec, windowSec, pixelsPerSample, sampleIntervalSec, rightChartX, maxValueDraw, chartTop, chartHeight) {
    const cutoff = nowSec - windowSec;
    const raw = [];
    for (let i = 0; i < series.length; i++) {
        const p = series[i];
        if (!p || p.length < 2) continue;
        const t = p[0];
        if (typeof t !== 'number' || t < cutoff) continue;
        let v = p[1];
        if (maxT !== null && t === maxT) v = displayV;
        if (typeof v !== 'number' || isNaN(v) || v < 0) continue;
        raw.push({ t, v });
    }
    raw.sort((a, b) => a.t - b.t);
    const pts = [];
    for (let j = 0; j < raw.length; j++) {
        const x = rightChartX - (nowSec - raw[j].t) / sampleIntervalSec * pixelsPerSample;
        const yRatio = maxValueDraw > 0 ? Math.min(raw[j].v / maxValueDraw, 1) : 0;
        const y = chartTop + chartHeight * (1 - yRatio);
        pts.push([x, y]);
    }
    return pts;
}

/**
 * Draws one interface history chart (time-based horizontal scroll + optional spline)
 * @param {string} interfaceName
 */
function drawHistoryChartInterface(interfaceName) {
    const canvas = document.getElementById(`chart-${interfaceName}`);
    if (!canvas || !initialBandwidthHistory || !initialBandwidthHistory.interfaces) return;

    const interfaceData = initialBandwidthHistory.interfaces[interfaceName];
    if (!interfaceData || !interfaceData.in || !interfaceData.out) return;

    const w = Math.max(0, Math.round(canvas.offsetWidth));
    const h = Math.max(0, Math.round(canvas.offsetHeight));
    if (w <= 0 || h <= 0) return;
    if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    seedHistoryChartAnimationIfNeeded(initialBandwidthHistory);
    const anim = historyChartAnimationByInterface[interfaceName];
    const nowMs = performance.now();
    const displayIn = anim ? getDisplayedSeriesValue(anim.in, nowMs) : 0;
    const displayOut = anim ? getDisplayedSeriesValue(anim.out, nowMs) : 0;

    const latestIn = getLatestHistoryPoint(interfaceData.in);
    const latestOut = getLatestHistoryPoint(interfaceData.out);
    const maxTIn = latestIn ? latestIn[0] : null;
    const maxTOut = latestOut ? latestOut[0] : null;

    let maxValue = 0.1;
    const bumpMax = (series, maxT, displayV) => {
        series.forEach(p => {
            if (!p || p.length < 2) return;
            let v = p[1];
            if (maxT !== null && p[0] === maxT) v = displayV;
            if (typeof v === 'number' && !isNaN(v) && v >= 0) maxValue = Math.max(maxValue, v);
        });
    };
    bumpMax(interfaceData.in, maxTIn, displayIn);
    bumpMax(interfaceData.out, maxTOut, displayOut);
    maxValue *= 1.2;
    const maxValueDraw = getSmoothedAxisMaxForInterface(anim, maxValue);

    const isDarkMode = document.documentElement.getAttribute('data-theme') === 'dark';
    const bgColor = isDarkMode ? '#1e1e1e' : '#ffffff';
    const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-grid-color').trim() || '#ccc';
    const inColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-in-color').trim() || '#0a0';
    const outColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-out-color').trim() || '#00a';
    const labelColor = getComputedStyle(document.documentElement).getPropertyValue('--chart-label-color').trim() || '#666';

    const padding = { top: 10, right: 12, bottom: 22, left: 36 };
    const chartWidth = canvas.width - padding.left - padding.right;
    const chartHeight = canvas.height - padding.top - padding.bottom;
    if (chartWidth <= 0 || chartHeight <= 0) return;

    const rightChartX = padding.left + chartWidth;

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(padding.left, padding.top, chartWidth, chartHeight);

    const yAxisValues = getNiceAxisValues(maxValueDraw, 3);
    for (let i = 0; i < yAxisValues.length; i++) {
        const value = yAxisValues[i];
        if (typeof value !== 'number' || isNaN(value)) continue;
        const y = padding.top + chartHeight * (1 - value / maxValueDraw);
        if (y < padding.top || y > padding.top + chartHeight) continue;
        ctx.beginPath();
        ctx.moveTo(padding.left, y);
        ctx.lineTo(rightChartX, y);
        ctx.stroke();
    }

    let oldestTimestamp = Infinity;
    interfaceData.in.forEach(p => { if (p && p.length >= 1) oldestTimestamp = Math.min(oldestTimestamp, p[0]); });
    interfaceData.out.forEach(p => { if (p && p.length >= 1) oldestTimestamp = Math.min(oldestTimestamp, p[0]); });
    if (!isFinite(oldestTimestamp)) {
        oldestTimestamp = Math.floor(Date.now() / 1000);
    }

    const tLatest = Math.max(maxTIn != null ? maxTIn : 0, maxTOut != null ? maxTOut : 0);
    const sampleIntervalSec = getHistorySampleIntervalSec(initialBandwidthHistory);
    // nowSec is the right-edge anchor: "now" in wall-clock unix seconds.
    // Every rAF frame this advances, causing all points to drift left continuously.
    const nowSec = Date.now() / 1000;

    const windowSec = Math.min(Math.max(tLatest - oldestTimestamp, sampleIntervalSec), 3600);
    // pixels per sampleIntervalSec of time: chartWidth / (windowSec / sampleIntervalSec)
    const pixelsPerSample = chartWidth * sampleIntervalSec / windowSec;

    const xGridLines = 2;
    for (let i = 0; i <= xGridLines; i++) {
        const x = padding.left + chartWidth * (i / xGridLines);
        ctx.beginPath();
        ctx.moveTo(x, padding.top);
        ctx.lineTo(x, padding.top + chartHeight);
        ctx.stroke();
    }

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = labelColor;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let i = 0; i < yAxisValues.length; i++) {
        const value = yAxisValues[i];
        if (typeof value !== 'number' || isNaN(value)) continue;
        const y = padding.top + chartHeight * (1 - value / maxValueDraw);
        if (y < padding.top || y > padding.top + chartHeight) continue;
        ctx.fillText(formatBandwidth(value), padding.left - 4, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let i = 0; i <= xGridLines; i++) {
        const x = padding.left + chartWidth * (i / xGridLines);
        // i=0 → left edge = oldest (nowSec - windowSec), i=xGridLines → right edge = nowSec
        const timestamp = nowSec - windowSec * (1 - i / xGridLines);
        ctx.fillText(formatTime(timestamp), x, canvas.height - 18);
    }

    const chartTop = padding.top;
    const inPoints = mapHistorySeriesToCanvasPoints(
        interfaceData.in, maxTIn, displayIn, nowSec, windowSec, pixelsPerSample, sampleIntervalSec, rightChartX, maxValueDraw, chartTop, chartHeight
    );
    const outPoints = mapHistorySeriesToCanvasPoints(
        interfaceData.out, maxTOut, displayOut, nowSec, windowSec, pixelsPerSample, sampleIntervalSec, rightChartX, maxValueDraw, chartTop, chartHeight
    );

    const strokeSeries = isSmoothHistoryChartStrokeEnabled() ? drawSeriesSplineWithTrailingEdge : drawSeriesWithTrailingEdge;

    ctx.lineWidth = 2;
    if (inPoints.length > 0) {
        ctx.strokeStyle = inColor;
        strokeSeries(ctx, inPoints, rightChartX);
    }
    if (outPoints.length > 0) {
        ctx.strokeStyle = outColor;
        strokeSeries(ctx, outPoints, rightChartX);
    }
}

/**
 * Redraws every visible history chart for the current frame
 */
function drawAllHistoryChartsFrame() {
    if (!initialBandwidthHistory || !initialBandwidthHistory.interfaces) return;
    Object.keys(initialBandwidthHistory.interfaces).forEach(interfaceName => {
        if (document.getElementById(`chart-${interfaceName}`)) {
            drawHistoryChartInterface(interfaceName);
        }
    });
}

/**
 * rAF callback: repaint charts and schedule the next frame
 */
function historyChartAnimationFrame() {
    historyChartRafId = null;
    if (document.querySelector('.history-chart')) {
        drawAllHistoryChartsFrame();
    }
    historyChartRafId = requestAnimationFrame(historyChartAnimationFrame);
}

/**
 * Starts the continuous history chart animation loop (idempotent)
 */
function startHistoryChartAnimationLoop() {
    if (historyChartRafId !== null) return;
    historyChartRafId = requestAnimationFrame(historyChartAnimationFrame);
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
 * Seeds animation state, draws one frame, and starts the continuous chart rAF loop
 */
function drawHistoryCharts() {
    debugLog("Drawing history charts...");
    if (!initialBandwidthHistory || !initialBandwidthHistory.interfaces) {
        debugLog("No bandwidth history data available");
        return;
    }
    debugLog("Available interfaces:", Object.keys(initialBandwidthHistory.interfaces));
    removeLegacyHistoryAxisLabels();
    seedHistoryChartAnimationIfNeeded(initialBandwidthHistory);
    drawAllHistoryChartsFrame();
    startHistoryChartAnimationLoop();
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
         initialBandwidthHistory = historyData;
         syncHistoryChartAnimationOnNewPayload(historyData);
         startHistoryChartAnimationLoop();
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
                            if (historyData && historyData.interfaces) {
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
            setupSmoothHistoryChartToggle();
            refitAllInterfaceCardTitles();
            setupInterfaceTitleResizeObservers();
            setTimeout(() => {
                drawHistoryCharts(); // Initial chart draw + start rAF loop
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

    const themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', () => {
            requestAnimationFrame(refitAllInterfaceCardTitles);
        });
    }
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
