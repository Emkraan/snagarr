/*
 * Snagarr - History module.
 *
 * The History section is server-rendered with the Cobalt v2 macros
 * (components/history_section.html): a page_header + Clear button, a filter row
 * (app select / search / page-size), a macro table, loading + empty states, and
 * prev/next pagination. This module POPULATES that markup - it never rebuilds
 * the shell. It preserves the original endpoints and behaviours:
 *   - GET    /api/history/<app_type>?page&page_size&search  (paged fetch)
 *   - DELETE /api/history/<app_type>                        (clear)
 * Operation types render as Cobalt badges with tone by outcome.
 */
const historyModule = {
    // State
    currentApp: 'all',
    currentPage: 1,
    totalPages: 1,
    pageSize: 20,
    searchQuery: '',
    isLoading: false,

    // DOM elements
    elements: {},

    // Initialize the history module
    init: function() {
        this.cacheElements();
        this.setupEventListeners();

        // Initial load if history is active section
        if (typeof snagarrUI !== 'undefined' && snagarrUI && snagarrUI.currentSection === 'history') {
            this.loadHistory();
        }
    },

    // Cache DOM elements
    cacheElements: function() {
        const section = document.getElementById('historySection');
        this.elements = {
            section: section,

            // Table + state containers
            tableWrap: section ? section.querySelector('.table-wrap') : null,
            historyTableBody: document.getElementById('historyTableBody'),
            historyEmptyState: document.getElementById('historyEmptyState'),
            historyLoading: document.getElementById('historyLoading'),

            // Controls
            historyAppSelect: document.getElementById('historyAppSelect'),
            historySearchInput: document.getElementById('historySearchInput'),
            historySearchButton: document.getElementById('historySearchButton'),
            historyPageSize: document.getElementById('historyPageSize'),
            clearHistoryButton: document.getElementById('clearHistoryButton'),

            // Pagination
            historyPrevPage: document.getElementById('historyPrevPage'),
            historyNextPage: document.getElementById('historyNextPage'),
            historyCurrentPage: document.getElementById('historyCurrentPage'),
            historyTotalPages: document.getElementById('historyTotalPages'),

            // Stat strip (lively hero)
            statStrip: document.getElementById('historyStatStrip'),
            hstTotal: document.getElementById('hstTotal'),
            hstTotalSub: document.getElementById('hstTotalSub'),
            hstSearches: document.getElementById('hstSearches'),
            hstSearchesSub: document.getElementById('hstSearchesSub'),
            hstUpgrades: document.getElementById('hstUpgrades'),
            hstUpgradesSub: document.getElementById('hstUpgradesSub'),
            hstApps: document.getElementById('hstApps'),
            hstAppsSub: document.getElementById('hstAppsSub')
        };
    },

    // Stat-strip state: last filter signature we summarised, and a one-shot
    // force flag (set after a clear, when counts change without the filter).
    _summarySig: null,
    _summaryForce: false,

    // Set up event listeners
    setupEventListeners: function() {
        const e = this.elements;

        if (e.historyAppSelect) {
            e.historyAppSelect.addEventListener('change', (ev) => {
                this.handleHistoryAppChange(ev.target.value);
            });
        }

        if (e.historySearchButton) {
            e.historySearchButton.addEventListener('click', () => this.handleSearch());
        }
        if (e.historySearchInput) {
            e.historySearchInput.addEventListener('keypress', (ev) => {
                if (ev.key === 'Enter') this.handleSearch();
            });
        }

        if (e.historyPageSize) {
            e.historyPageSize.addEventListener('change', () => this.handlePageSizeChange());
        }

        if (e.clearHistoryButton) {
            e.clearHistoryButton.addEventListener('click', () => this.handleClearHistory());
        }

        if (e.historyPrevPage) {
            e.historyPrevPage.addEventListener('click', () => this.handlePagination('prev'));
        }
        if (e.historyNextPage) {
            e.historyNextPage.addEventListener('click', () => this.handlePagination('next'));
        }
    },

    // Load history data when section becomes active
    loadHistory: function() {
        if (this.elements.historyTableBody) {
            this.fetchHistoryData();
        }
    },

    // Handle app selection changes
    handleHistoryAppChange: function(value) {
        const selectedApp = value;
        if (!selectedApp || selectedApp === this.currentApp) return;
        this.currentPage = 1;
        this.currentApp = selectedApp;
        this.fetchHistoryData();
    },

    // Handle search
    handleSearch: function() {
        const newSearchQuery = this.elements.historySearchInput
            ? this.elements.historySearchInput.value.trim() : '';

        if (newSearchQuery !== this.searchQuery) {
            this.searchQuery = newSearchQuery;
            this.currentPage = 1;
            this.fetchHistoryData();
        }
    },

    // Handle page size change
    handlePageSizeChange: function() {
        const newPageSize = parseInt(this.elements.historyPageSize.value, 10);
        if (newPageSize !== this.pageSize) {
            this.pageSize = newPageSize;
            this.currentPage = 1;
            this.fetchHistoryData();
        }
    },

    // Handle pagination
    handlePagination: function(direction) {
        if (direction === 'prev' && this.currentPage > 1) {
            this.currentPage--;
            this.fetchHistoryData();
        } else if (direction === 'next' && this.currentPage < this.totalPages) {
            this.currentPage++;
            this.fetchHistoryData();
        }
    },

    // Handle clear history
    handleClearHistory: function() {
        const label = this.currentApp === 'all' ? 'all history' : this.currentApp + ' history';
        if (confirm(`Are you sure you want to clear ${label}?`)) {
            this.clearHistory();
        }
    },

    // Fetch history data from API
    fetchHistoryData: function() {
        this.setLoading(true);

        let url = `/api/history/${this.currentApp}?page=${this.currentPage}&page_size=${this.pageSize}`;
        if (this.searchQuery) {
            url += `&search=${encodeURIComponent(this.searchQuery)}`;
        }

        fetch(url)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                this.totalPages = data.total_pages || 1;
                this.renderHistoryData(data);
                this.updatePaginationUI();
                this.setLoading(false);
                // Refresh the lively stat strip. Only re-aggregates when the
                // filter (app + search) changed or a clear forced it - plain
                // pagination reuses the last summary.
                this.refreshStatStrip();
            })
            .catch(error => {
                console.error('Error fetching history data:', error);
                this.showError('Failed to load history data. Please try again later.');
                this.setLoading(false);
            });
    },

    // Clear history
    clearHistory: function() {
        this.setLoading(true);
        // Counts change without the filter changing - force a re-aggregate.
        this._summaryForce = true;

        fetch(`/api/history/${this.currentApp}`, { method: 'DELETE' })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! Status: ${response.status}`);
                }
                return response.json();
            })
            .then(() => { this.fetchHistoryData(); })
            .catch(error => {
                console.error('Error clearing history:', error);
                this.showError('Failed to clear history. Please try again later.');
                this.setLoading(false);
            });
    },

    // Render history data to the server-rendered table
    renderHistoryData: function(data) {
        const tableBody = this.elements.historyTableBody;
        if (!tableBody) return;
        tableBody.innerHTML = '';

        if (!data.entries || data.entries.length === 0) {
            this.showEmptyState();
            return;
        }

        // Show table, hide empty state
        if (this.elements.historyEmptyState) this.elements.historyEmptyState.hidden = true;
        if (this.elements.tableWrap) this.elements.tableWrap.hidden = false;

        data.entries.forEach(entry => {
            const row = document.createElement('tr');

            const appType = entry.app_type
                ? entry.app_type.charAt(0).toUpperCase() + entry.app_type.slice(1) : '';
            const formattedInstance = appType
                ? `${appType} - ${entry.instance_name}` : (entry.instance_name || '');

            // Processed information: info icon (details on hover) + title.
            const processedCell = document.createElement('td');
            const line = document.createElement('div');
            line.className = 'history-processed';

            const info = document.createElement('span');
            info.className = 'history-info-ico';
            info.setAttribute('aria-hidden', 'true');
            info.innerHTML = this.infoIconSvg();
            info.title = this.buildDetails(entry);

            const title = document.createElement('span');
            title.className = 'history-title';
            title.textContent = entry.processed_info || '';

            line.appendChild(info);
            line.appendChild(title);
            processedCell.appendChild(line);

            // Operation badge (tone by outcome).
            const opCell = document.createElement('td');
            opCell.innerHTML = this.operationBadge(entry.operation_type);

            // ID (plain, mono).
            const idCell = document.createElement('td');
            idCell.className = 'mono';
            idCell.textContent = entry.id;

            const instanceCell = document.createElement('td');
            instanceCell.textContent = formattedInstance;

            const timeCell = document.createElement('td');
            timeCell.textContent = entry.how_long_ago || '';

            row.appendChild(processedCell);
            row.appendChild(opCell);
            row.appendChild(idCell);
            row.appendChild(instanceCell);
            row.appendChild(timeCell);

            tableBody.appendChild(row);
        });
    },

    // Update pagination UI
    updatePaginationUI: function() {
        if (this.elements.historyCurrentPage) {
            this.elements.historyCurrentPage.textContent = this.currentPage;
        }
        if (this.elements.historyTotalPages) {
            this.elements.historyTotalPages.textContent = this.totalPages;
        }
        if (this.elements.historyPrevPage) {
            this.elements.historyPrevPage.disabled = this.currentPage <= 1;
        }
        if (this.elements.historyNextPage) {
            this.elements.historyNextPage.disabled = this.currentPage >= this.totalPages;
        }
    },

    // Show empty state
    showEmptyState: function() {
        if (this.elements.tableWrap) this.elements.tableWrap.hidden = true;
        if (this.elements.historyEmptyState) this.elements.historyEmptyState.hidden = false;
    },

    // ── Stat strip (lively hero) ─────────────────────────────────────────────
    // Aggregates REAL counts from the same /api/history/<app> endpoint the table
    // uses, honouring the active app + search filter. Hidden when zero records.

    // Ease a numeric node from its current value to `target`.
    animateStat: function(node, target) {
        if (!node) return;
        target = parseInt(target, 10) || 0;
        const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const start = parseInt(String(node.textContent).replace(/[^\d-]/g, ''), 10) || 0;
        if (reduce || start === target) { node.textContent = target.toLocaleString(); return; }
        const t0 = performance.now(), dur = 800;
        const step = (now) => {
            const k = Math.min(1, (now - t0) / dur), e = k * (2 - k);
            node.textContent = Math.floor(start + (target - start) * e).toLocaleString();
            if (k < 1) requestAnimationFrame(step); else node.textContent = target.toLocaleString();
        };
        requestAnimationFrame(step);
    },

    hideStatStrip: function() {
        if (this.elements.statStrip) this.elements.statStrip.hidden = true;
    },

    // Fetch a summary for the current filter and paint the strip. Skips the
    // network round-trip when neither the filter nor a clear changed the data.
    refreshStatStrip: function() {
        if (!this.elements.statStrip) return; // markup absent - nothing to do

        const sig = this.currentApp + '|' + this.searchQuery;
        if (sig === this._summarySig && !this._summaryForce) return;
        this._summarySig = sig;
        this._summaryForce = false;

        // Large page_size: the backend already loads every entry into memory
        // before paginating, so this returns the full filtered set for exact
        // per-operation counts rather than a single visible page.
        let url = `/api/history/${this.currentApp}?page=1&page_size=100000`;
        if (this.searchQuery) url += `&search=${encodeURIComponent(this.searchQuery)}`;

        fetch(url)
            .then(response => {
                if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
                return response.json();
            })
            .then(data => this.renderStatStrip(data))
            .catch(error => {
                // Never break the view on a summary failure - just hide the strip.
                console.error('Error building history stat strip:', error);
                this._summarySig = null; // allow a retry on the next reload
                this.hideStatStrip();
            });
    },

    renderStatStrip: function(data) {
        const e = this.elements;
        if (!e.statStrip) return;

        const entries = (data && Array.isArray(data.entries)) ? data.entries : [];
        const total = (data && typeof data.total_entries === 'number')
            ? data.total_entries : entries.length;

        // Zero records for this filter: hide rather than show a broken row of 0s.
        if (!total || entries.length === 0) { this.hideStatStrip(); return; }

        let upgrades = 0;
        const apps = new Set(), instances = new Set();
        entries.forEach(entry => {
            if (String(entry.operation_type || '').toLowerCase() === 'upgrade') upgrades++;
            if (entry.app_type) apps.add(entry.app_type);
            if (entry.instance_name) instances.add(entry.instance_name);
        });
        const searches = Math.max(0, entries.length - upgrades);
        const pct = (n) => entries.length ? Math.round((n / entries.length) * 100) : 0;

        this.animateStat(e.hstTotal, total);
        this.animateStat(e.hstSearches, searches);
        this.animateStat(e.hstUpgrades, upgrades);
        this.animateStat(e.hstApps, apps.size);

        // Real, derived sub-labels.
        if (e.hstTotalSub) {
            const scope = this.currentApp === 'all'
                ? 'across all apps'
                : 'in ' + this.currentApp.charAt(0).toUpperCase() + this.currentApp.slice(1);
            e.hstTotalSub.textContent = this.searchQuery ? scope + ' (filtered)' : scope;
        }
        if (e.hstSearchesSub) e.hstSearchesSub.textContent = pct(searches) + '% of processed';
        if (e.hstUpgradesSub) e.hstUpgradesSub.textContent = pct(upgrades) + '% of processed';
        if (e.hstAppsSub) {
            const n = instances.size;
            e.hstAppsSub.textContent = n + (n === 1 ? ' instance' : ' instances');
        }

        e.statStrip.hidden = false;
    },

    // Show error via the shared toast/notification systems
    showError: function(message) {
        if (typeof window.toast === 'function') {
            window.toast(message, 'error');
        } else if (typeof snagarrUI !== 'undefined' && typeof snagarrUI.showNotification === 'function') {
            snagarrUI.showNotification(message, 'error');
        } else {
            alert(message);
        }
    },

    // Set loading state
    setLoading: function(isLoading) {
        this.isLoading = isLoading;
        const e = this.elements;

        if (isLoading) {
            if (e.historyLoading) e.historyLoading.hidden = false;
            if (e.tableWrap) e.tableWrap.hidden = true;
            if (e.historyEmptyState) e.historyEmptyState.hidden = true;
        } else {
            if (e.historyLoading) e.historyLoading.hidden = true;
        }
    },

    // Build a plain-text details blob for the processed-info tooltip
    buildDetails: function(entry) {
        const details = {
            title: entry.processed_info,
            id: entry.id,
            app: entry.app_type || 'Unknown',
            instance: entry.instance_name || 'Default',
            date: entry.date_time_readable,
            operation: entry.operation_type
        };
        try {
            return JSON.stringify(details, null, 2);
        } catch (err) {
            return String(entry.processed_info || '');
        }
    },

    // Inline info glyph (Lucide style, matches _icons.info)
    infoIconSvg: function() {
        return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
               'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
               '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/>' +
               '<line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    },

    // Map an operation type to a Cobalt badge (class matches the `badge` macro)
    operationBadge: function(operationType) {
        const tones = {
            success: 'success',
            upgrade: 'info',
            warning: 'warning',
            missing: 'danger',
            error: 'danger'
        };
        const key = (operationType || '').toLowerCase();
        const tone = tones[key];
        const label = operationType
            ? operationType.charAt(0).toUpperCase() + operationType.slice(1)
            : 'Unknown';
        const span = document.createElement('span');
        span.className = 'badge' + (tone ? ' tone-' + tone : '');
        span.textContent = label;
        return span.outerHTML;
    }
};

// Initialize when the DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    historyModule.init();

    // Hook into the SPA router: load history when its section is shown.
    if (typeof snagarrUI !== 'undefined' && typeof snagarrUI.switchSection === 'function') {
        const originalSwitchSection = snagarrUI.switchSection;
        snagarrUI.switchSection = function(section) {
            originalSwitchSection.call(snagarrUI, section);
            if (section === 'history') {
                historyModule.loadHistory();
            }
        };
    }
});
