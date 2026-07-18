/**
 * Scheduling functionality for Huntarr
 * Implements a SABnzbd-style scheduler for controlling Arr application behavior
 */

// Define the schedules object in the global window scope to prevent redeclaration errors
// This ensures the variable is only declared once no matter how many times the script loads
window.huntarrSchedules = window.huntarrSchedules || {
    global: [],
    sonarr: [],
    radarr: [],
    lidarr: [],
    readarr: []
};

// Use an immediately invoked function expression to create a new scope
(function() {
    // Reference the global schedules object
    const schedules = window.huntarrSchedules;
    
    /**
     * Capitalize the first letter of a string
     * @param {string} string - The string to capitalize
     * @returns {string} - The capitalized string
     */
    function capitalizeFirst(string) {
        if (!string) return '';
        return string.charAt(0).toUpperCase() + string.slice(1);
    }

    /**
     * Route a user-facing message through the Cobalt toast system, falling back
     * to snagarrUI.showNotification, then alert.
     * @param {string} message
     * @param {string} type - 'success' | 'error'
     */
    function notify(message, type) {
        if (typeof window.toast === 'function') {
            window.toast(message, type === 'error' ? 'error' : 'success');
            return;
        }
        if (window.snagarrUI && typeof window.snagarrUI.showNotification === 'function') {
            window.snagarrUI.showNotification(message, type);
            return;
        }
        alert(message);
    }
    
    // Initialize when document is loaded
    document.addEventListener('DOMContentLoaded', function() {
        // Initialize the scheduler
        initScheduler();
        
        // Load existing schedules
        loadSchedules();
        
        // Set up event listeners
        setupEventListeners();
        
        // Load app instances dynamically
        loadAppInstances();
    });

/**
 * Initialize the scheduler functionality
 */
function initScheduler() {
    console.debug('Initializing scheduler'); // DEBUG level per user preference
    
    // Load and render the schedules
    loadSchedules();
    
    // Initialize the app dropdown
    loadAppInstances();
    
    // Set up event listeners
    setupEventListeners();
    
    // Initialize time inputs with current time
    const now = new Date();
    const hour = now.getHours();
    const minute = Math.floor(now.getMinutes() / 5) * 5; // Round to nearest 5 minutes
    
    const hourSelect = document.getElementById('scheduleHour');
    const minuteSelect = document.getElementById('scheduleMinute');
    
    if (hourSelect && minuteSelect) {
        hourSelect.value = hour;
        minuteSelect.value = minute;
    }

    // Check if we're on the scheduling section
    if (window.location.hash === '#scheduling') {
        // Make sure nav item is active
        const schedulingNav = document.getElementById('schedulingNav');
        if (schedulingNav) schedulingNav.classList.add('active');
    }
}

/**
 * Set up event listeners for the scheduler UI
 */
function setupEventListeners() {
    // Add Schedule button (edit functionality removed for simplicity)
    const addScheduleButton = document.getElementById('addScheduleButton');
    if (addScheduleButton) {
        addScheduleButton.addEventListener('click', function() {
            // Always treat as a new schedule - edit functionality removed
            addSchedule();
        });
    }
    
    // Save button functionality removed since we're using auto-save

    // Reflect the hidden day checkboxes onto their Cobalt chip labels.
    syncDayChips();

    // Only set up the event handler during initialization, not on every page render
    // Use a closure to ensure event listener is registered only once
    if (!window.huntarrSchedulerInitialized) {
        // Keep chip .active state in sync when a day chip is toggled.
        document.addEventListener('change', function(e) {
            if (e.target && e.target.classList && e.target.classList.contains('day-input')) {
                const chip = e.target.closest('[data-day-chip]');
                if (chip) chip.classList.toggle('active', e.target.checked);
            }
        });

        // Document level listener to catch delete actions regardless of when items are added
        document.addEventListener('click', function(e) {
            // Only react to delete buttons
            const deleteButton = e.target.closest('.delete-schedule');
            if (deleteButton) {
                // Prevent default and bubbling to avoid multiple handlers
                e.preventDefault();
                e.stopPropagation();
                
                const scheduleId = deleteButton.dataset.id;
                const appType = deleteButton.dataset.appType || 'global';
                
                // One single confirmation dialog
                if (confirm('Are you sure you want to delete this schedule?')) {
                    deleteSchedule(scheduleId, appType);
                }
            }
        });
        
        // Flag to prevent duplicate initialization
        window.huntarrSchedulerInitialized = true;
        console.debug('Scheduler event handlers initialized once');
    }
}

/**
 * Fetch app instances from the pre-generated list.json file
 * @returns {Promise<Object>} - Object containing app instances
 */
async function fetchAppInstances() {
    console.debug('Fetching app instances from list.json for scheduler dropdown'); // DEBUG level per user preference
    
    // Define the app types we support (for fallback)
    const appTypes = ['sonarr', 'radarr', 'lidarr', 'readarr', 'whisparr', 'eros', 'bazarr'];
    const instances = {};
    
    // Initialize all app types with empty arrays
    appTypes.forEach(appType => {
        instances[appType] = [];
    });
    
    try {
        // Add a cache-busting parameter to ensure we get fresh data
        const cacheBuster = new Date().getTime();
        const listUrl = `/config/scheduling/list.json?nocache=${cacheBuster}`;
        
        console.debug(`Loading app instances from ${listUrl}`);
        const response = await fetch(listUrl);
        
        if (response.ok) {
            const data = await response.json();
            console.debug('Successfully loaded app instances from list.json');
            
            // Process each app type from the list.json file
            for (const appType of appTypes) {
                if (data[appType] && Array.isArray(data[appType]) && data[appType].length > 0) {
                    instances[appType] = data[appType];
                    console.debug(`Added ${instances[appType].length} ${appType} instances from list.json`);
                } else {
                    // Add a fallback default instance if none found
                    console.debug(`No ${appType} instances found in list.json, adding default fallback`);
                    instances[appType] = [
                        { id: '0', name: `${capitalizeFirst(appType)} Default` }
                    ];
                }
            }
        } else {
            console.warn(`Error fetching list.json: ${response.status} ${response.statusText}`);
            // Add fallback defaults for all app types
            useDefaultInstances(instances, appTypes);
        }
    } catch (error) {
        console.warn('Error fetching app instances from list.json:', error);
        // Add fallback defaults for all app types
        useDefaultInstances(instances, appTypes);
    }
    
    console.debug('Final instances object:', instances);
    return instances;
}

/**
 * Add default instances for all app types as a fallback
 * @param {Object} instances - The instances object to populate
 * @param {Array} appTypes - Array of app types to create defaults for
 */
function useDefaultInstances(instances, appTypes) {
    console.debug('Using default instances for all app types');
    appTypes.forEach(appType => {
        instances[appType] = [
            { id: '0', name: `${capitalizeFirst(appType)} Default` }
        ];
    });
}

/**
 * Load standard apps for the scheduler
 */
function loadAppInstances() {
    console.debug('Loading standard apps for scheduler dropdown'); // DEBUG level per user preference
    
    const scheduleApp = document.getElementById('scheduleApp');
    if (!scheduleApp) {
        console.error('Schedule app dropdown not found in DOM');
        return;
    }
    
    // Clear existing options
    scheduleApp.innerHTML = '';
    
    // Define the standard apps list
    const standardApps = [
        { value: 'global', text: 'All Apps (Global)' },
        { value: 'sonarr-all', text: 'Sonarr' },
        { value: 'radarr-all', text: 'Radarr' },
        { value: 'lidarr-all', text: 'Lidarr' },
        { value: 'readarr-all', text: 'Readarr' },
        { value: 'whisparr-v2', text: 'Whisparr V2' },
        { value: 'whisparr-v3', text: 'Whisparr V3' }
    ];
    
    // Add each app to the dropdown
    standardApps.forEach(app => {
        const option = document.createElement('option');
        option.value = app.value;
        option.textContent = app.text;
        scheduleApp.appendChild(option);
    });
    
    console.debug('Standard apps loaded for scheduler');
}

/**
 * Format app instances data to a consistent structure
 * @param {Object} data Raw app instances data
 * @returns {Object} Formatted app instances data
 */
function formatAppInstances(data) {
    const formatted = {};
    
    // Check if data is in the expected format
    if (typeof data !== 'object') {
        throw new Error('Invalid app instances data format');
    }
    
    // Process different potential formats
    if (Array.isArray(data)) {
        // Handle array format - group by app type
        data.forEach(instance => {
            if (!instance.type) return;
            
            const appType = instance.type.toLowerCase();
            if (!formatted[appType]) {
                formatted[appType] = [];
            }
            
            formatted[appType].push({
                id: instance.id || formatted[appType].length + 1,
                name: instance.name || `${capitalizeFirst(appType)} Instance ${instance.id || formatted[appType].length + 1}`
            });
        });
    } else {
        // Handle object format with app types as keys
        Object.keys(data).forEach(appType => {
            const normalizedType = appType.toLowerCase();
            
            if (Array.isArray(data[appType])) {
                formatted[normalizedType] = data[appType].map((instance, index) => {
                    // Handle if instance is just a string or object
                    if (typeof instance === 'string') {
                        return {
                            id: (index + 1).toString(),
                            name: instance
                        };
                    } else if (typeof instance === 'object') {
                        return {
                            id: instance.id || (index + 1).toString(),
                            name: instance.name || `${capitalizeFirst(normalizedType)} Instance ${instance.id || index + 1}`
                        };
                    }
                }).filter(Boolean); // Remove any undefined entries
            }
            // If days is already in our format
            else if (typeof data[appType] === 'object' && data[appType] !== null) {
                // Handle object with instance IDs as keys
                formatted[normalizedType] = Object.keys(data[appType]).map((id) => {
                    const instance = data[appType][id];
                    return {
                        id: id,
                        name: instance.name || `${capitalizeFirst(normalizedType)} Instance ${id}`
                    };
                });
            }
        });
    }
    
    return formatted;
}

/**
 * Load schedules from server JSON files via API
 */
function loadSchedules() {
    console.debug('Loading schedules from server'); // DEBUG level per user preference
    
    // Make API call to get schedules
    fetch('/api/scheduler/load')
        .then(response => {
            if (!response.ok) {
                throw new Error('Failed to load schedules');
            }
            return response.json();
        })
        .then(data => {
            console.debug('Loaded schedules from server:', data);
            
            // Process the data to ensure it's in the correct format
            Object.keys(schedules).forEach(key => {
                if (Array.isArray(data[key])) {
                    // Process each schedule to ensure correct format
                    schedules[key] = data[key].map(schedule => {
                        // Make sure we have a proper time object
                        let timeObj = schedule.time;
                        if (typeof schedule.time === 'string') {
                            // Convert string time (HH:MM) to time object {hour: HH, minute: MM}
                            const [hour, minute] = schedule.time.split(':').map(Number);
                            timeObj = { hour, minute };
                        } else if (!schedule.time) {
                            timeObj = { hour: 0, minute: 0 };
                        }
                        
                        return {
                            id: schedule.id || String(Date.now() + Math.random() * 1000),
                            time: timeObj,
                            days: Array.isArray(schedule.days) ? schedule.days : [],
                            action: schedule.action || 'pause',
                            app: schedule.app || 'global',
                            appType: schedule.appType || key, // Preserve the appType
                            enabled: schedule.enabled !== false
                        };
                    });
                } else {
                    schedules[key] = [];
                }
            });
            
            console.debug('Processed schedules for rendering:', schedules);
            renderSchedules();
        })
        .catch(error => {
            console.error('Error loading schedules:', error);
            // Initialize empty schedule structure if load fails
            Object.keys(schedules).forEach(key => {
                schedules[key] = [];
            });
            renderSchedules();
        });
}

/**
 * Parse days from API format to our internal format
 */
function parseDays(daysData) {
    // Default all days to false
    const days = {
        monday: false,
        tuesday: false,
        wednesday: false,
        thursday: false,
        friday: false,
        saturday: false,
        sunday: false
    };
    
    // If days is an array of day names
    if (Array.isArray(daysData)) {
        daysData.forEach(day => {
            // Convert day names to our format (e.g., 'Mon' -> 'monday')
            const dayLower = day.toLowerCase();
            if (dayLower.startsWith('mon')) days.monday = true;
            else if (dayLower.startsWith('tue')) days.tuesday = true;
            else if (dayLower.startsWith('wed')) days.wednesday = true;
            else if (dayLower.startsWith('thu')) days.thursday = true;
            else if (dayLower.startsWith('fri')) days.friday = true;
            else if (dayLower.startsWith('sat')) days.saturday = true;
            else if (dayLower.startsWith('sun')) days.sunday = true;
        });
    }
    // If days is already in our format
    else if (daysData && typeof daysData === 'object') {
        Object.assign(days, daysData);
    }
    
    return days;
}

/**
 * Save schedules to server via API
 */
function saveSchedules() {
    console.debug('Saving schedules to server');
    
    try {
        // Before saving, ensure that schedules include appType information
        // This ensures consistent data structure between saves and loads
        const schedulesCopy = {};
        
        // Initialize with empty arrays for each app type
        Object.keys(schedules).forEach(key => {
            schedulesCopy[key] = [];
        });
        
        // Process each schedule and ensure proper formatting before saving
        Object.entries(schedules).forEach(([appType, appSchedules]) => {
            if (Array.isArray(appSchedules)) {
                schedulesCopy[appType] = appSchedules.map(schedule => {
                    // Clean up the schedule object to ensure it has all required fields
                    // Convert days from object format to array format if needed
                    let daysArray = [];
                    if (schedule.days) {
                        if (typeof schedule.days === 'object' && !Array.isArray(schedule.days)) {
                            // Convert from object format {monday: true, tuesday: false} to array ['monday']
                            Object.entries(schedule.days).forEach(([day, selected]) => {
                                if (selected === true) {
                                    daysArray.push(day);
                                }
                            });
                        } else if (Array.isArray(schedule.days)) {
                            // Already an array, just use it
                            daysArray = schedule.days;
                        }
                    }
                    
                    return {
                        id: schedule.id,
                        time: schedule.time,
                        days: daysArray, // Use the array format
                        action: schedule.action,
                        app: schedule.app || 'global',
                        enabled: schedule.enabled !== false,
                        appType: appType // Store appType as a property for reference when loading
                    };
                });
            }
        });
        
        console.debug('Saving processed schedules:', schedulesCopy);
        
        // Make API call to save schedules
        fetch('/api/scheduler/save', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(schedulesCopy)
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error('Failed to save schedules');
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    console.debug('Schedules saved successfully');
                    // Show success toast notification
                    notify('Schedules saved successfully!', 'success');

                    // Update our schedules object with the cleaned version
                    Object.keys(schedules).forEach(key => {
                        schedules[key] = schedulesCopy[key];
                    });
                } else {
                    console.error('Failed to save schedules:', data.message);
                    notify(`Failed to save: ${data.message}`, 'error');
                }
            })
            .catch(error => {
                console.error('Error saving schedules:', error);
                notify('Failed to save schedules!', 'error');
            });
    } catch (error) {
        console.error('Error in save function:', error);
    }
}

/**
 * Get formatted schedules for rendering
 * This combines schedules from all app types into a single flat array
 */
function getFormattedSchedules() {
    const formattedSchedules = [];
    
    // Flatten all app type schedules into a single array
    Object.entries(schedules).forEach(([appType, appSchedules]) => {
        if (Array.isArray(appSchedules)) {
            appSchedules.forEach(schedule => {
                // Ensure we have the correct appType for UI operations
                formattedSchedules.push({
                    ...schedule,
                    appType: schedule.appType || appType // Use existing appType if present, otherwise use the key
                });
            });
        }
    });
    
    console.debug('Formatted schedules for display:', formattedSchedules);
    return formattedSchedules;
}

// Trash glyph (Lucide, matches _icons.html trash macro) for row delete buttons.
const TRASH_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';

/**
 * Render schedules into the server-rendered Cobalt table.
 */
function renderSchedules() {
    // Server-rendered nodes: a <tbody> for rows, a table wrap, and an empty state.
    const schedulesContainer = document.getElementById('schedulesContainer');
    const noSchedulesMessage = document.getElementById('noSchedulesMessage');
    const tableWrap = document.getElementById('schedulesTableWrap');

    if (!schedulesContainer || !noSchedulesMessage) {
        console.warn('Schedule container elements not found, cannot render schedules');
        return;
    }

    // Clear current rows
    schedulesContainer.innerHTML = '';

    // Get all schedules in a flat array
    const allSchedules = getFormattedSchedules();

    // Count total schedules
    const totalSchedules = allSchedules.length;

    // Refresh the header posture strip from the same in-memory schedule data.
    try { renderSchedHero(allSchedules); } catch (e) { console.warn('Schedule hero render failed:', e); }

    // Show empty state if no schedules
    if (totalSchedules === 0) {
        if (tableWrap) tableWrap.style.display = 'none';
        noSchedulesMessage.style.display = 'block';
        return;
    }

    // Show table and hide empty state
    if (tableWrap) tableWrap.style.display = '';
    noSchedulesMessage.style.display = 'none';

    // Sort schedules by time for easier viewing
    allSchedules.sort((a, b) => {
        if (!a.time) return 1;
        if (!b.time) return -1;

        const aTime = `${String(a.time.hour).padStart(2, '0')}:${String(a.time.minute).padStart(2, '0')}`;
        const bTime = `${String(b.time.hour).padStart(2, '0')}:${String(b.time.minute).padStart(2, '0')}`;
        return aTime.localeCompare(bTime);
    });

    // Add each schedule to the UI
    allSchedules.forEach(schedule => {
        const scheduleItem = document.createElement('tr');

        // Format time
        const formattedTime = `${String(schedule.time.hour).padStart(2, '0')}:${String(schedule.time.minute).padStart(2, '0')}`;
        
        // Format days
        let daysText = '';
        if (Array.isArray(schedule.days)) {
            // API format - array of day names
            if (schedule.days.length === 7) {
                daysText = 'Daily';
            } else if (schedule.days.length === 0) {
                daysText = 'None';
            } else {
                // Format day names nicely (e.g., 'Mon, Wed, Fri')
                daysText = schedule.days.map(day => {
                    // Capitalize first letter and take first 3 characters
                    return day.substring(0, 1).toUpperCase() + day.substring(1, 3);
                }).join(', ');
            }
        } else if (typeof schedule.days === 'object') {
            // Internal format - object with day properties
            const allDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
            const selectedDays = allDays.filter(day => schedule.days[day]);
            
            if (selectedDays.length === 7) {
                daysText = 'Daily';
            } else if (selectedDays.length === 0) {
                daysText = 'None';
            } else {
                // Format day names nicely (e.g., 'Mon, Wed, Fri')
                daysText = selectedDays.map(day => day.substring(0, 1).toUpperCase() + day.substring(1, 3)).join(', ');
            }
        }
        
        // Format action name
        let actionText = schedule.action || '';
        if (actionText === 'resume' || actionText === 'enable') {
            actionText = 'Enable';
        } else if (actionText === 'pause' || actionText === 'disable') {
            actionText = 'Disable';
        } else if (actionText.startsWith('api-')) {
            const limit = actionText.split('-')[1];
            actionText = `API Limits ${limit}`;
        }
        
        // Format app name
        let appText = 'All Apps';
        if (schedule.app && schedule.app !== 'global') {
            // Format app name nicely using the actual instance name
            const [app, instanceId] = schedule.app.split('-');
            if (instanceId === 'all') {
                appText = `All ${capitalizeFirst(app)} Instances`;
            } else if (app === 'whisparr' && instanceId === 'v2') {
                appText = 'Whisparr V2';
            } else if (app === 'whisparr' && instanceId === 'v3') {
                appText = 'Whisparr V3';
            } else {
                appText = `${capitalizeFirst(app)} Instance ${instanceId}`;
            }
        }
        
        // Build the schedule row (Cobalt table cells)
        scheduleItem.innerHTML = `
            <td class="sched-time-cell">${formattedTime}</td>
            <td>${daysText}</td>
            <td>${actionText}</td>
            <td>${appText}</td>
            <td class="r">
                <span class="sched-row-actions">
                    <button type="button" class="icon-btn delete-schedule" aria-label="Delete schedule" title="Delete schedule" data-id="${schedule.id}" data-app-type="${schedule.appType}">${TRASH_SVG}</button>
                </span>
            </td>
        `;

        // Delete is handled by the document-level listener in setupEventListeners.

        // Add to container
        schedulesContainer.appendChild(scheduleItem);
    });
}

/**
 * Add a new schedule
 */
function addSchedule() {
    // Get form values
    const hour = parseInt(document.getElementById('scheduleHour').value);
    const minute = parseInt(document.getElementById('scheduleMinute').value);
    const action = document.getElementById('scheduleAction').value;
    
    // Get selected days
    const days = {
        monday: document.getElementById('day-monday').checked,
        tuesday: document.getElementById('day-tuesday').checked,
        wednesday: document.getElementById('day-wednesday').checked,
        thursday: document.getElementById('day-thursday').checked,
        friday: document.getElementById('day-friday').checked,
        saturday: document.getElementById('day-saturday').checked,
        sunday: document.getElementById('day-sunday').checked
    };
    
    // Calculate if any day was selected
    const anyDaySelected = Object.values(days).some(dayIsSelected => dayIsSelected === true);
    
    // Validate form inputs (basic validation)
    if (isNaN(hour) || isNaN(minute)) {
        notify('Please enter a valid hour and minute.', 'error');
        return;
    }

    if (!anyDaySelected) {
        notify('Please select at least one day to save the schedule.', 'error');
        console.error('Validation Error: No day selected for the new schedule.');
        return;
    }
    
    const app = document.getElementById('scheduleApp').value;
    
    // Convert days from object format to array format
    const daysArray = [];
    Object.entries(days).forEach(([day, selected]) => {
        if (selected === true) {
            daysArray.push(day);
        }
    });
    
    // Create new schedule object
    const newSchedule = {
        id: Date.now().toString(), // Unique ID for the new schedule
        time: { hour, minute },
        days: daysArray, // Store days as array
        action,
        app,
        enabled: true
    };
    
    // Determine app type for this schedule
    let appType = 'global';
    if (app && app !== 'global') {
        const appParts = app.split('-');
        appType = appParts[0] || 'global';
    }
    
    // Make sure the array exists for this app type
    if (!schedules[appType]) {
        schedules[appType] = [];
    }
    
    // Add to appropriate schedules array
    schedules[appType].push(newSchedule);
    
    // Auto-save schedules after adding
    saveSchedules();
    
    // Log at DEBUG level
    console.debug(`Added new schedule to ${appType}:`, newSchedule);
    
    // Update UI
    renderSchedules();
    
    // Reset day checkboxes
    resetDayCheckboxes();
}

// Execution history functionality has been removed as requested

/**
 * Format days from internal format to API format (array of day names)
 */
function formatDaysForAPI(days) {
    const apiDays = [];
    
    if (days.monday) apiDays.push('Mon');
    if (days.tuesday) apiDays.push('Tue');
    if (days.wednesday) apiDays.push('Wed');
    if (days.thursday) apiDays.push('Thu');
    if (days.friday) apiDays.push('Fri');
    if (days.saturday) apiDays.push('Sat');
    if (days.sunday) apiDays.push('Sun');
    
    return apiDays;
}

/**
 * Edit functionality has been removed for simplicity
 * Users can now only add new schedules or delete existing ones
 */

/**
 * Delete a schedule (no confirmations to prevent multiple dialog issues)
 */
function deleteSchedule(scheduleId, appType = 'global') {
    console.debug(`Deleting schedule ID: ${scheduleId} from ${appType}`); // DEBUG level per user preference
    
    // Ensure the app type array exists
    if (!schedules[appType]) {
        schedules[appType] = [];
        return;
    }
    
    // Find the schedule index
    const scheduleIndex = schedules[appType].findIndex(s => s.id === scheduleId);
    if (scheduleIndex === -1) return;
    
    // Remove from array
    schedules[appType].splice(scheduleIndex, 1);
    
    // Auto-save schedules after deletion
    saveSchedules();
    
    // Update UI
    renderSchedules();
    
    console.debug(`Successfully deleted schedule ID: ${scheduleId} from ${appType}`); // DEBUG level per user preference
}

/**
 * Toggle schedule functionality removed
 * This function is kept as a stub in case other code references it
 */
function toggleScheduleEnabled(scheduleId, appType = 'global', enabled) {
    // Function kept as a stub but functionality removed
    console.debug('Toggle schedule enabled called, but functionality removed');
}

/**
 * Reset day checkboxes to unchecked (and clear their chip highlight).
 */
function resetDayCheckboxes() {
    ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].forEach(day => {
        const cb = document.getElementById('day-' + day);
        if (cb) cb.checked = false;
    });
    syncDayChips();
}

/**
 * Reflect each hidden day checkbox's state onto its Cobalt chip label.
 */
function syncDayChips() {
    document.querySelectorAll('#schedulingSection [data-day-chip]').forEach(chip => {
        const cb = chip.querySelector('.day-input');
        chip.classList.toggle('active', !!(cb && cb.checked));
    });
}

/**
 * Render the header posture strip (weekday-coverage dial, active-schedule count,
 * a 7-chip weekday strip, and a "next run" label) from the already-loaded
 * schedule data. Purely additive and read-only; hides itself when there are no
 * active schedules so an empty state never shows zeros as if broken.
 *
 * @param {Array} allSchedules - Flat list from getFormattedSchedules().
 */
function renderSchedHero(allSchedules) {
    const hero = document.getElementById('schedHero');
    if (!hero) return; // View not on the page yet; nothing to do.

    const list = Array.isArray(allSchedules) ? allSchedules : [];
    const active = list.filter(s => s && s.enabled !== false);

    // No real data -> gracefully hide the whole element.
    if (active.length === 0) {
        hero.hidden = true;
        hero.setAttribute('aria-hidden', 'true');
        return;
    }

    // 3-letter day prefix -> JS Date.getDay() index (Sun=0).
    const DAY3 = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const covered = new Set();
    const now = new Date();
    let best = null;

    active.forEach(s => {
        const t = s.time || {};
        const hh = Number(t.hour);
        const mm = Number(t.minute);

        // Normalise days to an array of lowercase name strings.
        let names = [];
        if (Array.isArray(s.days)) {
            names = s.days.map(d => String(d).toLowerCase());
        } else if (s.days && typeof s.days === 'object') {
            names = Object.keys(s.days).filter(k => s.days[k]);
        }

        names.forEach(n => {
            const idx = DAY3[n.slice(0, 3)];
            if (idx === undefined) return;
            covered.add(idx);

            // Derive the soonest upcoming run across every active schedule.
            if (isNaN(hh) || isNaN(mm)) return;
            const diff = (idx - now.getDay() + 7) % 7;
            const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + diff, hh, mm, 0, 0);
            if (cand <= now) cand.setDate(cand.getDate() + 7); // Already passed today -> next week.
            if (!best || cand < best) best = cand;
        });
    });

    // Active-schedule count.
    const cntEl = document.getElementById('schedActiveVal');
    if (cntEl) cntEl.textContent = String(active.length);

    // Weekday-coverage dial (conic ring fill + "N/7" label), matching the dashboard rings.
    const coveredCount = covered.size;
    const dial = document.getElementById('schedCoverDial');
    const dialVal = document.getElementById('schedCoverVal');
    if (dial) dial.style.setProperty('--v', Math.round((coveredCount / 7) * 100));
    if (dialVal) dialVal.textContent = coveredCount + '/7';

    // Highlight the weekday chips that actually have a schedule.
    const NAME_IDX = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0 };
    hero.querySelectorAll('.sched-week-chip').forEach(chip => {
        const day = chip.getAttribute('data-week-day') || '';
        const idx = NAME_IDX[day];
        chip.classList.toggle('active', idx !== undefined && covered.has(idx));
    });

    // "Next run" label: absolute weekday/time plus a relative countdown.
    const nextEl = document.getElementById('schedNext');
    if (nextEl) {
        if (best) {
            const wk = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][best.getDay()];
            const hhs = String(best.getHours()).padStart(2, '0');
            const mms = String(best.getMinutes()).padStart(2, '0');
            const mins = Math.round((best - now) / 60000);
            let rel;
            if (mins < 60) rel = 'in ' + Math.max(1, mins) + 'm';
            else if (mins < 1440) rel = 'in ' + Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
            else rel = 'in ' + Math.floor(mins / 1440) + 'd ' + Math.floor((mins % 1440) / 60) + 'h';
            nextEl.textContent = 'Next ' + wk + ' ' + hhs + ':' + mms + ' · ' + rel;
            nextEl.hidden = false;
        } else {
            nextEl.hidden = true; // No derivable next run (e.g. schedules with no days).
        }
    }

    hero.hidden = false;
    hero.removeAttribute('aria-hidden');
}

// Close the IIFE that wraps the script
})();
