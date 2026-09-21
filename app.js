// Web Storage is not always reachable: private-browsing quotas, blocked
        // third-party cookies, and sandboxed iframes all make a bare
        // `localStorage` read throw SecurityError. Ad-network previewers frame
        // the page exactly that way, so an unguarded read used to take the whole
        // script down before the ruler was ever drawn. Preferences fall back to
        // memory — they stop persisting across visits, but nothing else breaks.
        const safeStorage = (() => {
            const wrap = (name) => {
                const memory = new Map();
                const fallback = {
                    getItem: key => (memory.has(key) ? memory.get(key) : null),
                    setItem: (key, value) => { memory.set(key, String(value)); },
                    removeItem: key => { memory.delete(key); }
                };
                let store = null;
                try {
                    // Reading the property and writing to it can fail separately,
                    // so probe with a real round trip rather than a presence check.
                    const candidate = window[name];
                    const probeKey = '__screen_ruler_probe__';
                    candidate.setItem(probeKey, '1');
                    candidate.removeItem(probeKey);
                    store = candidate;
                } catch (_) {
                    return fallback;
                }
                // A store that probes clean can still throw later once its quota
                // fills, so every call keeps its own guard.
                return {
                    getItem: key => { try { return store.getItem(key); } catch (_) { return fallback.getItem(key); } },
                    setItem: (key, value) => { try { store.setItem(key, value); } catch (_) { fallback.setItem(key, value); } },
                    removeItem: key => { try { store.removeItem(key); } catch (_) { fallback.removeItem(key); } }
                };
            };
            return { local: wrap('localStorage'), session: wrap('sessionStorage') };
        })();

        const devicePresetData = window.SCREEN_RULER_DEVICE_DATA || { presets: [], modelAliases: [] };
        const PRESETS = devicePresetData.presets;
        const MODEL_TO_PRESET = devicePresetData.modelAliases;
        const MODEL_ALIASES_BY_PRESET = new Map();
        MODEL_TO_PRESET.forEach(([model, presetName]) => {
            const aliases = MODEL_ALIASES_BY_PRESET.get(presetName) || [];
            aliases.push(model);
            MODEL_ALIASES_BY_PRESET.set(presetName, aliases);
        });
        let detectedDeviceModel = '';
        const onlineLookupConfig = window.SCREEN_RULER_CONFIG || {};
        let onlineLookupInFlight = false;
        let mobileApiCreditAvailable = null;
        let onboardingOnlineMatchApplied = false;
        let calibrationTemplateLookupInFlight = false;
        let onboardingTemplateMatchApplied = false;
        let lastSelectedDeviceName = '';
        let hasSessionDeviceNameEdit = false;
        let hasSessionRulerScaleEdit = false;
        let calibrationTouched = false;
        let calibrationReturnFocus = null;
        let communityTemplateSearchSequence = 0;
        const communityTemplateSearchCache = new Map();

        function getPhysicalScreenResolution() {
            const dpr = window.devicePixelRatio || 1;
            return {
                width: Math.round((window.screen.width || window.innerWidth) * dpr),
                height: Math.round((window.screen.height || window.innerHeight) * dpr),
                dpr
            };
        }

        async function detectDeviceProfile() {
            try {
                if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
                    const hints = await navigator.userAgentData.getHighEntropyValues(['model', 'platform', 'platformVersion']);
                    detectedDeviceModel = (hints.model || '').trim();
                }
            } catch (_) {
                // Client hints are optional; a device can still be selected manually.
            }

            if (!detectedDeviceModel) {
                const uaModel = navigator.userAgent.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/|\))/i);
                detectedDeviceModel = uaModel ? uaModel[1].trim() : '';
            }
        }

        function setOnlineLookupStatus(message, isError = false, context = 'settings') {
            const status = document.getElementById(context === 'onboarding' ? 'onboardOnlineLookupStatus' : 'onlineLookupStatus');
            if (!status) return;
            status.textContent = message;
            status.className = `text-[10px] ${isError ? 'text-rose-400' : 'text-neutral-500'}`;
        }

        function setOnboardOnlineLookupVisible(visible) {
            const section = document.getElementById('onboardOnlineLookupSection');
            if (section) section.classList.toggle('hidden', !visible);
        }

        async function checkMobileApiCreditAvailability() {
            const endpoint = onlineLookupConfig.lookupEndpoint;
            if (!endpoint || !navigator.onLine) {
                mobileApiCreditAvailable = false;
                setOnboardOnlineLookupVisible(false);
                return false;
            }

            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: getSupabaseHeaders(),
                    body: JSON.stringify({ action: 'availability' })
                });
                const result = await response.json();
                mobileApiCreditAvailable = response.ok && result.available === true;
                setOnboardOnlineLookupVisible(mobileApiCreditAvailable);
                return mobileApiCreditAvailable;
            } catch (_) {
                // Keep the paid third-party option out of the intro when its
                // availability cannot be confirmed; presets remain available.
                mobileApiCreditAvailable = false;
                setOnboardOnlineLookupVisible(false);
                return false;
            }
        }

        async function lookupDeviceOnline(context = 'settings') {
            if (onlineLookupInFlight) return;
            const endpoint = onlineLookupConfig.lookupEndpoint;
            const publicKey = onlineLookupConfig.supabaseAnonKey;
            if (!endpoint) {
                setOnlineLookupStatus('Online lookup is not configured for this site yet.', true, context);
                return;
            }

            await detectDeviceProfile();
            const model = detectedDeviceModel.trim();
            if (!model || model.length < 2 || model.toUpperCase() === 'K') {
                setOnlineLookupStatus('This browser did not provide a usable device model. Choose a device manually.', true, context);
                return;
            }

            const button = document.getElementById(context === 'onboarding' ? 'onboardOnlineLookupButton' : 'onlineLookupButton');
            if (!button) return;
            onlineLookupInFlight = true;
            button.disabled = true;
            button.classList.add('opacity-50', 'cursor-wait');
            setOnlineLookupStatus('Looking up this device…', false, context);

            try {
                const signature = getPhysicalScreenResolution();
                const headers = { 'Content-Type': 'application/json' };
                if (publicKey) {
                    headers.apikey = publicKey;
                    headers.Authorization = `Bearer ${publicKey}`;
                }
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ model, width: signature.width, height: signature.height, dpr: signature.dpr })
                });
                const result = await response.json();
                if (!response.ok) {
                    if (response.status === 429 && result.quota_scope === 'global') {
                        mobileApiCreditAvailable = false;
                        setOnboardOnlineLookupVisible(false);
                    }
                    throw new Error(result.error || 'Lookup failed');
                }
                if (!result.match) {
                    setOnlineLookupStatus('No confident online match found. Choose a device manually.', true, context);
                    return;
                }

                diagonal = result.match.diagonal;
                scaleReferenceDiagonal = diagonal;
                customDiagonal = diagonal;
                customWidth = result.match.width;
                customHeight = result.match.height;
                activePresetName = `${result.match.brand} ${result.match.name} (${diagonal.toFixed(2)}")`;
                // The provider gives physical display pixels, while the canvas uses
                // CSS pixels. Convert the physical PPI through DPR before drawing.
                const physicalPpi = Math.hypot(result.match.width, result.match.height) / diagonal;
                ppi = physicalPpi / Math.max(1, signature.dpr || 1);

                safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
                safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
                safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);
                applySavedMetrics();
                if (context === 'onboarding') {
                    onboardingOnlineMatchApplied = true;
                    document.getElementById('onboardSearchInput').value = activePresetName;
                }
                const scaleMessage = `Matched ${result.match.brand} ${result.match.name}. Scale set to ${Math.round(ppi)} PPI.`;
                setOnlineLookupStatus(context === 'onboarding' ? `${scaleMessage} Press Done to continue.` : scaleMessage, false, context);
                showToast('Online device match applied.');
            } catch (error) {
                setOnlineLookupStatus(error.message || 'Online lookup is unavailable.', true, context);
            } finally {
                onlineLookupInFlight = false;
                button.disabled = false;
                button.classList.remove('opacity-50', 'cursor-wait');
            }
        }

        function getSupabaseHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            if (onlineLookupConfig.supabaseAnonKey) {
                headers.apikey = onlineLookupConfig.supabaseAnonKey;
                headers.Authorization = `Bearer ${onlineLookupConfig.supabaseAnonKey}`;
            }
            return headers;
        }

        function getCalibrationTemplateEndpoint() {
            return onlineLookupConfig.calibrationTemplateEndpoint ||
                'https://awenpzziosomkocigbri.supabase.co/functions/v1/calibration-template';
        }

        function isUsefulCalibrationModel(model) {
            const normalised = normaliseModelText(model);
            const placeholders = new Set([
                'ANDROID', 'IPHONE', 'MOBILE', 'PHONE', 'K', 'CHOOSEADEVICE',
                'CUSTOMDEVICE', 'CUSTOMUSERDEVICE', 'CUSTOMOVERRIDDENSIZE',
                'CUSTOMOVERRIDESELECTION', 'MANUALLYTUNEDMESH'
            ]);
            return normalised.length >= 3 && !placeholders.has(normalised) && !normalised.startsWith('COMMUNITYTEMPLATE');
        }

        function getCalibrationModelHint() {
            const deviceInput = document.getElementById('deviceSearchInput')?.value;
            return [deviceInput, lastSelectedDeviceName, detectedDeviceModel, activePresetName]
                .map(value => String(value || '').trim())
                .find(isUsefulCalibrationModel) || '';
        }

        function getCalibrationTemplateAliases() {
            const deviceTitle = document.getElementById('deviceSearchInput')?.value;
            // Only share the title the user sees/edits and the browser-provided
            // hint. A nearby preset may have been used merely as a calibration
            // starting point, so it must not become a misleading public alias.
            return [...new Set([deviceTitle, detectedDeviceModel]
                .map(value => String(value || '').trim())
                .filter(isUsefulCalibrationModel))];
        }

        function getMatchingStandardPreset() {
            return PRESETS.find(preset => preset.name.toLowerCase() === activePresetName.toLowerCase()) || null;
        }

        function calibrationDiffersFromStandardPreset() {
            const preset = getMatchingStandardPreset();
            // A selected built-in preset is already shareable local catalogue data.
            // The manual adjustment paths change activePresetName to a custom value,
            // which is when a community calibration can add something new.
            return !preset && (hasSessionDeviceNameEdit || hasSessionRulerScaleEdit);
        }

        function calibrationTemplateSignature() {
            return [
                getCalibrationTemplateAliases().join('|').toUpperCase(), Math.round(customWidth), Math.round(customHeight),
                diagonal.toFixed(2), ppi.toFixed(2)
            ].join('|');
        }

        function updateCalibrationTemplateSaveControl() {
            const block = document.getElementById('saveCalibrationTemplateBlock');
            const button = document.getElementById('saveCalibrationTemplateButton');
            const status = document.getElementById('saveCalibrationTemplateStatus');
            if (!block || !button || !status) return;

            if (!calibrationDiffersFromStandardPreset()) {
                block.dataset.available = 'false';
                block.classList.add('hidden');
                block.dataset.savedSignature = '';
                return;
            }

            const signature = calibrationTemplateSignature();
            block.dataset.available = 'true';
            // Sharing needs the community database, so follow the same detected
            // connectivity rule as the optional bottom ad.
            block.classList.toggle('hidden', activeTab !== 'calibrate' || !navigator.onLine);
            if (block.dataset.savedSignature === signature) {
                button.disabled = true;
                button.textContent = 'Calibration saved';
                status.textContent = 'This adjusted device calibration has been saved.';
            } else {
                button.disabled = false;
                button.textContent = 'Share calibration';
                status.textContent = 'Share this device model name and custom dimensions to the database so others don’t have to manually calibrate.';
            }
        }

        async function lookupCalibrationTemplate() {
            const endpoint = getCalibrationTemplateEndpoint();
            if (!endpoint || !isUsefulCalibrationModel(detectedDeviceModel) || calibrationTemplateLookupInFlight) return null;

            calibrationTemplateLookupInFlight = true;
            try {
                const signature = getPhysicalScreenResolution();
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: getSupabaseHeaders(),
                    body: JSON.stringify({
                        action: 'lookup', model: detectedDeviceModel,
                        width: signature.width, height: signature.height
                    }),
                    // Onboarding is awaiting this, so a request that never settles
                    // would leave the visitor on a page that never finishes
                    // starting. An abort lands in the catch below like any other
                    // failure and the flow carries on without a template.
                    signal: AbortSignal.timeout ? AbortSignal.timeout(6000) : undefined
                });
                const result = await response.json();
                return response.ok && result.template ? result.template : null;
            } catch (_) {
                // A template lookup is an optional local-catalogue fallback. The
                // onboarding flow continues normally if the service is unavailable.
                return null;
            } finally {
                calibrationTemplateLookupInFlight = false;
            }
        }

        function applyCalibrationTemplate(template) {
            const signature = getPhysicalScreenResolution();
            diagonal = Number(template.diagonal);
            customDiagonal = diagonal;
            customWidth = Number(template.width);
            customHeight = Number(template.height);
            scaleReferenceDiagonal = diagonal;
            // Derive this browser's CSS-pixel PPI from the shared physical display
            // data instead of reusing another browser's possibly zoomed PPI value.
            ppi = Math.hypot(customWidth, customHeight) / diagonal / Math.max(1, signature.dpr || 1);
            lastSelectedDeviceName = template.model_hint;
            activePresetName = `Community template: ${template.model_hint} (${diagonal.toFixed(2)}")`;
            document.getElementById('onboardSearchInput').value = activePresetName;
            onboardingTemplateMatchApplied = true;
        }

        function applyCommunityTemplateFromSearch(template, context = 'settings') {
            const signature = getPhysicalScreenResolution();
            diagonal = Number(template.diagonal);
            customDiagonal = diagonal;
            customWidth = Number(template.width);
            customHeight = Number(template.height);
            scaleReferenceDiagonal = diagonal;
            ppi = Math.hypot(customWidth, customHeight) / diagonal / Math.max(1, signature.dpr || 1);
            lastSelectedDeviceName = template.model_hint;
            activePresetName = `Community template: ${template.model_hint} (${diagonal.toFixed(2)}")`;

            if (context === 'onboarding') {
                onboardingOnlineMatchApplied = false;
                onboardingTemplateMatchApplied = true;
                document.getElementById('onboardSearchInput').value = activePresetName;
                showToast('Community calibration selected. Press Done to continue.');
                return;
            }

            safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
            safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
            safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);
            applySavedMetrics();
            showToast('Community calibration applied.');
        }

        async function saveDeviceCalibrationTemplate() {
            const endpoint = getCalibrationTemplateEndpoint();
            if (!endpoint) {
                showToast('Calibration saving is not configured yet.');
                return;
            }

            await detectDeviceProfile();
            let model = getCalibrationModelHint();
            if (!isUsefulCalibrationModel(model)) {
                const deviceInput = document.getElementById('deviceSearchInput');
                deviceInput.focus();
                showToast('Enter the device name in the Device field before sharing.');
                return;
            }

            const button = document.getElementById('saveCalibrationTemplateButton');
            const status = document.getElementById('saveCalibrationTemplateStatus');
            button.disabled = true;
            status.textContent = 'Saving calibration…';
            try {
                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: getSupabaseHeaders(),
                    body: JSON.stringify({
                        action: 'save', model,
                        aliases: getCalibrationTemplateAliases(),
                        width: Math.round(customWidth), height: Math.round(customHeight),
                        diagonal: Number(diagonal.toFixed(2)), ppi: Number(ppi.toFixed(2))
                    })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Could not save this calibration.');
                lastSelectedDeviceName = model;
                document.getElementById('saveCalibrationTemplateBlock').dataset.savedSignature = calibrationTemplateSignature();
                updateCalibrationTemplateSaveControl();
                showToast('Device calibration saved. Thank you!');
            } catch (error) {
                button.disabled = false;
                status.textContent = error.message || 'Could not save this calibration.';
            }
        }

        let ppi = 133.93; 
        let diagonal = 6.55;
        let scaleReferenceDiagonal = 6.55;
        let activePresetName = "Motorola Edge 40 / Pro (6.55\")";
        let currentTheme = 'dark';
        let activeTab = 'calibrate';
        let showCalibration = false;
        let showGrid = 'metric';
        let showCalipers = true;
        let showProtractor = false;
        let protractorAngleA = 35;
        let protractorAngleB = 125;
        let activeProtractorGuide = null;
        let activeProtractorPointerId = null;
        let inchFormat = safeStorage.local.getItem('calibrated_ruler_inch_format') || 'fraction';
        let rulerUnitOrder = safeStorage.local.getItem('calibrated_ruler_unit_order') || 'metric-primary';

        // Custom device calculations state
        let customWidth = 1080;
        let customHeight = 2400;
        let customDiagonal = 6.55;

        let pointA = { x: 100, y: 150 };
        let pointB = { x: 300, y: 450 };
        // Caliper positions are retained in the phone's natural portrait axes.
        // The visible points are projected from these coordinates after every
        // rotation or viewport resize, so a 90-degree turn does not squash them.
        let physicalPointA = null;
        let physicalPointB = null;
        let activePoint = null;
        let activePointerId = null;
        
        // A point handle is deliberately easier to grab than a guide line, without
        // stealing ordinary taps from a large part of the canvas.
        const DRAG_THRESHOLD = 34;
        const LINE_GRAB_MARGIN = 16;
        let caliperDraggedThisInteraction = false;
        let ignoreNextClick = false;
        let areControlsHidden = false;
        const AD_DISMISSED_SESSION_KEY = 'screen_ruler_bottom_ad_dismissed';
        const AD_SETTINGS_UNLOCKED_KEY = 'screen_ruler_ads_control_unlocked';
        const ADS_DISABLED_KEY = 'screen_ruler_ads_disabled';
        const SETTINGS_HIDE_HOLD_MS = 5000;
        const SETTINGS_UNLOCK_HOLD_MS = 10000;
        const SETTINGS_BUTTON_POSITION_KEY = 'screen_ruler_settings_button_position';
        const SETTINGS_BUTTON_SIZE = 56;
        const SETTINGS_BUTTON_MARGIN = 16;
        const SETTINGS_BUTTON_GAP = 12;
        const SETTINGS_BUTTON_LIFT_MS = 450;
        const SETTINGS_BUTTON_DRAG_THRESHOLD = 14;
        let settingsHideTimer = null;
        let settingsUnlockTimer = null;
        let settingsLiftTimer = null;
        let settingsHoldHandled = false;
        let settingsButtonPointerId = null;
        let settingsButtonPressPoint = null;
        let settingsButtonLifted = false;
        let settingsButtonDragging = false;
        let pointerStartedInSettingsCard = false;

        const canvas = document.getElementById('rulerCanvas');
        const ctx = canvas.getContext('2d');
        const canvasMirror = document.getElementById('rulerCanvasMirror');
        const caliperHandleA = document.getElementById('caliperHandleA');
        const caliperHandleB = document.getElementById('caliperHandleB');
        const protractorHandleA = document.getElementById('protractorHandleA');
        const protractorHandleB = document.getElementById('protractorHandleB');
        const caliperGuideAX = document.getElementById('caliperGuideAX');
        const caliperGuideAY = document.getElementById('caliperGuideAY');
        const caliperGuideBX = document.getElementById('caliperGuideBX');
        const caliperGuideBY = document.getElementById('caliperGuideBY');
        const bubbleLevelPanel = document.getElementById('bubbleLevelPanel');
        const levelDrift = document.getElementById('levelDrift');
        const levelReadout = document.getElementById('levelReadout');
        const levelNeedle = document.getElementById('levelNeedle');
        const toggleControlsBtn = document.getElementById('toggleControlsBtn');
        const appControlsOverlay = document.getElementById('appControlsOverlay');
        const levelArcs = {
            left: document.getElementById('levelArcLeft'), right: document.getElementById('levelArcRight'),
            top: document.getElementById('levelArcTop'), bottom: document.getElementById('levelArcBottom')
        };
        const settingsCard = document.getElementById('settingsCard');
        const rulerToggleIcon = document.getElementById('rulerToggleIcon');
        const canUseBubbleLevel = 'DeviceOrientationEvent' in window || 'DeviceMotionEvent' in window;
        let bubbleLevelListening = false;
        let smoothedLevelTilt = null;
        let lastLevelSampleAt = 0;
        let lastGravitySampleAt = 0;
        let bubbleVisualPosition = null;
        let bubbleVisualTarget = null;
        let bubbleVisualFrame = null;
        let lastBubbleVisualFrameAt = 0;

        if (screen.orientation?.addEventListener) screen.orientation.addEventListener('change', resetBubbleLevelSmoothing);
        window.addEventListener('orientationchange', resetBubbleLevelSmoothing);
        if (screen.orientation?.addEventListener) screen.orientation.addEventListener('change', updateBottomAdAnchor);
        window.addEventListener('orientationchange', updateBottomAdAnchor);
        window.addEventListener('resize', updateBottomAdAnchor);
        window.addEventListener('resize', initializeBottomAd);
        window.addEventListener('resize', positionSettingsUI);
        window.addEventListener('online', () => {
            initializeBottomAd();
            updateCalibrationTemplateSaveControl();
            checkMobileApiCreditAvailability();
        });
        window.addEventListener('offline', () => {
            updateCalibrationTemplateSaveControl();
            mobileApiCreditAvailable = false;
            setOnboardOnlineLookupVisible(false);
        });

        mergeDeviceControlsIntoCalibrate();

        // Startup used to hang off `load`, which waits for every subresource —
        // the ad script included. Wherever that request is blocked or slow (ad
        // previewers and review crawlers commonly stall it), `load` never fires
        // and the canvas was left unsized on an empty page. Booting from
        // DOMContentLoaded keeps the ruler independent of the network.
        const trace = window.SCREEN_RULER_TRACE || function () {};

        let hasBooted = false;
        function bootApp() {
            if (hasBooted) return;
            const styles = getComputedStyle(document.documentElement);
            if (styles.getPropertyValue('--ruler-styles-ready').trim() !== '1' ||
                styles.getPropertyValue('--ruler-content-styles-ready').trim() !== '1') {
                document.getElementById('startupMessage').textContent = 'The measuring interface could not load its styles. Reload to retry, or use the guides above.';
                return;
            }
            hasBooted = true;
            trace('boot');
            syncAdPreferenceUI();
            initSearchDropdowns();
            initBubbleLevel();
            initBigRuler();
            window.requestAnimationFrame(positionSettingsUI);
            document.getElementById('inchFormatSelect').value = inchFormat;
            document.getElementById('rulerUnitsSelect').value = rulerUnitOrder;

            // Paint before anything asynchronous. The ruler needs no permission
            // and no network to draw - only a scale, and it always has one, even
            // if that is the built-in default. Everything below waits on client
            // hints and, for a visitor with no saved calibration, a template
            // lookup over the network, so leaving the first paint behind them
            // left the page black for as long as those took. A crawler that
            // serialises the dom on its own schedule then caught a black page
            // roughly half the time. The correctly scaled ruler follows a moment
            // later, from the same drawAll() that always redrew it.
            resizeCanvas();
            updateDisplayValues();
            drawAll();
            trace('firstdraw:' + canvas.width + 'x' + canvas.height);
            document.documentElement.removeAttribute('data-ruler-failed');
            document.documentElement.setAttribute('data-ruler-ready', 'true');
            document.getElementById('startupMessage').hidden = true;
            // The first visit starts with a usable ruler, not a modal.
            if (!areControlsHidden) toggleControls();
            window.requestAnimationFrame(initializeBottomAd);

            detectDeviceProfile().finally(async () => {
                updateOnboardingBubbleLevelControl();
                await checkFirstTimeOnboarding();
                resizeCanvas();
                updateDisplayValues();
                drawAll();
                trace('calibrated');
            }).catch(error => {
                trace('calibration-unavailable');
                console.warn('Automatic calibration unavailable; manual calibration is still available.', error);
            });

            window.addEventListener('resize', () => {
                resizeCanvas();
                if (!document.getElementById('deviceDropdownList').classList.contains('hidden')) positionDeviceDropdown();
                drawAll();
            });

            document.addEventListener('pointerdown', (e) => {
                pointerStartedInSettingsCard = Boolean(settingsCard?.contains(e.target));
            }, true);

            // Universal Click Handler (Handles dropdown dismissals and Tap-Away controls closing)
            document.addEventListener('click', (e) => {
                const interactionStartedInSettingsCard = pointerStartedInSettingsCard;
                pointerStartedInSettingsCard = false;
                if (ignoreNextClick) {
                    ignoreNextClick = false;
                    return;
                }

                // Autocomplete List Closures
                const listDevice = document.getElementById('deviceDropdownList');
                const searchDevice = document.getElementById('deviceSearchInput');
                if (listDevice && searchDevice && !searchDevice.contains(e.target) && !listDevice.contains(e.target)) {
                    listDevice.classList.add('hidden');
                }

                const listOnboard = document.getElementById('onboardDropdownList');
                const searchOnboard = document.getElementById('onboardSearchInput');
                if (listOnboard && searchOnboard && !searchOnboard.contains(e.target) && !listOnboard.contains(e.target)) {
                    listOnboard.classList.add('hidden');
                }

                // Hide Controls when tapping on empty canvas zone
                const readoutPanel = document.getElementById('readoutPanel');
                const toggleControlsBtn = document.getElementById('toggleControlsBtn');
                const onboardingModal = document.getElementById('onboardingModal');

                if (!areControlsHidden && !interactionStartedInSettingsCard &&
                    settingsCard && !settingsCard.contains(e.target) && 
                    !e.target.closest('#onboardingModal, #siteIntro, #showSiteIntro') &&
                    !listDevice.contains(e.target) &&
                    readoutPanel && !readoutPanel.contains(e.target) && 
                    toggleControlsBtn && !toggleControlsBtn.contains(e.target) &&
                    !e.target.closest('#caliperHandleLayer') &&
                    !e.target.closest('#caliperGuideLayer') &&
                    (!onboardingModal || onboardingModal.classList.contains('opacity-0'))) {
                    toggleControls();
                }
            });

            // Double tap canvas workspace toggles control board seamlessly
            let lastTap = 0;
            const handleDblTaps = (e) => {
                if (e.target.closest('#siteIntro, #showSiteIntro, a, summary')) return;
                if (!e.target.closest('button') && !e.target.closest('#settingsCard') && !e.target.closest('#readoutPanel') && !e.target.closest('#onboardingModal') && !e.target.closest('#deviceDropdownList')) {
                    toggleControls();
                }
            };
            document.addEventListener('touchend', (e) => {
                if (e.target.closest('#siteIntro, #showSiteIntro, a, summary')) return;
                if (ignoreNextClick) return; 
                let now = new Date().getTime();
                if (now - lastTap < 300 && now - lastTap > 0) {
                    handleDblTaps(e);
                    e.preventDefault();
                }
                lastTap = now;
            });
            document.addEventListener('dblclick', handleDblTaps);
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', bootApp, { once: true });
        } else {
            bootApp();
        }

        // Load provides a backstop if a local stylesheet arrived after DOM ready.
        window.addEventListener('load', () => {
            bootApp();
            resizeCanvas();
            drawAll();
            trace('load');
            window.requestAnimationFrame(positionSettingsUI);
        });

        async function checkFirstTimeOnboarding() {
            if (calibrationTouched) return;
            const savedPpi = safeStorage.local.getItem('calibrated_ruler_ppi');
            const savedDiag = safeStorage.local.getItem('calibrated_ruler_diagonal');
            const savedPresetName = safeStorage.local.getItem('calibrated_ruler_presetName');

            const signature = getPhysicalScreenResolution();
            const realW = signature.width;
            const realH = signature.height;
            const dpr = signature.dpr.toFixed(1);
            
            document.getElementById('bestGuessExplanation').innerHTML = 
                `Browsers hide physical display specifications to protect your privacy. Based on your detected screen resolution of <span class="text-emerald-400 font-mono font-bold">${realW} × ${realH}</span> (at a Device Pixel Ratio of <span class="text-emerald-400 font-mono font-bold">${dpr}</span>), we have pre-selected our best guess profile below. You can easily search for your phone inside the search bar.`;

            if (detectedDeviceModel) {
                document.getElementById('bestGuessExplanation').innerHTML +=
                    ` Browser model hint: <span class="text-emerald-400 font-mono font-bold">${escapeHtml(detectedDeviceModel)}</span>.`;
            }

            document.getElementById('bestGuessExplanation').textContent =
                'Is this your device and screen size? It determines the size of the ruler on screen. If it’s not, just go to the Calibrate tab to get the ruler accurate.';

            document.getElementById('bestGuessExplanation').innerHTML =
                `The webpage needs to know the size of your device to scale the ruler, if your phone model is in my database you can find it with "select your device", if that fails use "online device match" or calibrate the ruler yourself. Detected screen resolution: <span class="text-emerald-400 font-mono font-bold">${realW} &times; ${realH}</span> (Device Pixel Ratio <span class="text-emerald-400 font-mono font-bold">${dpr}</span>).`;
            if (detectedDeviceModel) {
                document.getElementById('bestGuessExplanation').innerHTML +=
                    ` Browser model hint: <span class="text-emerald-400 font-mono font-bold">${escapeHtml(detectedDeviceModel)}</span>.`;
            }

            if (savedPpi && savedDiag) {
                ppi = parseFloat(savedPpi);
                diagonal = parseFloat(savedDiag);
                activePresetName = savedPresetName || "Custom Preset";
                scaleReferenceDiagonal = diagonal;
                
                customWidth = realW;
                customHeight = realH;
                customDiagonal = diagonal;
                updateCustomInputsUI();
                applySavedMetrics();
            } else {
                const guess = makeBestResolutionGuess();
                if (guess) {
                    activePresetName = guess.name;
                    lastSelectedDeviceName = guess.name;
                    diagonal = guess.diagonal;
                    scaleReferenceDiagonal = guess.diagonal;
                    customWidth = guess.wMatch;
                    customHeight = guess.hMatch;
                    customDiagonal = guess.diagonal;
                    document.getElementById('onboardSearchInput').value = guess.name;
                    handleOnboardSelect(guess.name);
                } else {
                    const template = await lookupCalibrationTemplate();
                    if (calibrationTouched) return;
                    if (template) {
                        applyCalibrationTemplate(template);
                    } else {
                        activePresetName = 'Choose a device';
                        customWidth = realW;
                        customHeight = realH;
                        customDiagonal = diagonal;
                        document.getElementById('onboardSearchInput').value = '';
                        handleOnboardSelect('CUSTOM_DEVICE');
                    }
                }
                updateCustomInputsUI();

                // Setup is available from Choose device; never interrupt measuring.
            }
        }

        function makeBestResolutionGuess() {
            const { width: screenW, height: screenH } = getPhysicalScreenResolution();
            const modelMatch = findPresetFromModelHint(detectedDeviceModel);
            if (modelMatch) return modelMatch;

            // iOS normally exposes only the generic "iPhone" model. Keep a
            // resolution fallback only for that explicitly generic iPhone hint.
            const isGenericIphoneHint = normaliseModelText(detectedDeviceModel) === 'IPHONE';
            if (!isGenericIphoneHint) return null;
            const resolutionCandidates = PRESETS.filter(p => p.name.startsWith('iPhone'));
            
            let matched = resolutionCandidates[0] || PRESETS[0];
            let minDiff = Infinity;

            resolutionCandidates.forEach(p => {
                const diff = Math.abs(p.wMatch - screenW) + Math.abs(p.hMatch - screenH);
                const invertedDiff = Math.abs(p.hMatch - screenW) + Math.abs(p.wMatch - screenH); 
                const actualSmallest = Math.min(diff, invertedDiff);
                if (actualSmallest < minDiff) {
                    minDiff = actualSmallest;
                    matched = p;
                }
            });
            return matched;
        }

        function normaliseModelText(value) {
            return String(value || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
        }

        function tokeniseDeviceText(value) {
            return String(value || '').toUpperCase().match(/[A-Z0-9]+/g) || [];
        }

        function getPresetSearchText(preset) {
            return [preset.name, ...(MODEL_ALIASES_BY_PRESET.get(preset.name) || [])].join(' ');
        }

        function isSamsungModelHint(model) {
            return /\bSAMSUNG\b/i.test(model) || /^SM[\s._-]*[A-Z]\d{3}/i.test(model.trim());
        }

        function modelTokenMatches(candidateToken, queryToken) {
            return candidateToken.startsWith(queryToken) ||
                (candidateToken.length >= 4 && queryToken.startsWith(candidateToken));
        }

        function findPresetFromModelHint(model) {
            const hint = String(model || '').trim();
            const compactHint = normaliseModelText(hint);
            if (!compactHint || compactHint === 'IPHONE') return null;

            // Manufacturer codes may include a regional suffix (SM-A736B). Match
            // the stable code prefix before considering a consumer-facing name.
            const aliasMatch = MODEL_TO_PRESET
                .map(([alias, presetName]) => ({ alias: normaliseModelText(alias), presetName }))
                .filter(({ alias }) => alias.length >= 4 && compactHint.includes(alias))
                .sort((a, b) => b.alias.length - a.alias.length)[0];
            if (aliasMatch) return PRESETS.find(preset => preset.name === aliasMatch.presetName) || null;

            const queryTokens = tokeniseDeviceText(hint);
            const genericTokens = new Set(['ANDROID', 'GALAXY', 'IPHONE', 'MOBILE', 'PHONE', 'SAMSUNG', 'SM']);
            if (!queryTokens.some(token => !genericTokens.has(token) && token.length >= 2)) return null;

            const candidates = isSamsungModelHint(hint)
                ? PRESETS.filter(preset => preset.name.startsWith('Samsung '))
                : PRESETS.filter(preset => !preset.name.startsWith('iPhone'));
            const directMatches = candidates.filter(preset => {
                const compactPresetName = normaliseModelText(preset.name.replace(/\s*\([^)]*\)\s*$/, ''));
                if (compactPresetName.includes(compactHint) || compactHint.includes(compactPresetName)) return true;
                const candidateTokens = tokeniseDeviceText(getPresetSearchText(preset));
                let start = 0;
                return queryTokens.every(queryToken => {
                    const found = candidateTokens.findIndex((candidateToken, index) =>
                        index >= start && modelTokenMatches(candidateToken, queryToken)
                    );
                    if (found < 0) return false;
                    start = found + 1;
                    return true;
                });
            });

            return directMatches.length === 1 ? directMatches[0] : null;
        }

        function escapeHtml(value) {
            const el = document.createElement('div');
            el.textContent = value;
            return el.innerHTML;
        }

        function initSearchDropdowns() {
            mountDeviceDropdown();
            settingsCard.addEventListener('scroll', () => {
                if (!document.getElementById('deviceDropdownList').classList.contains('hidden')) positionDeviceDropdown();
            });
            filterDevicePresets('');
            filterOnboardPresets('');
        }

        function mergeDeviceControlsIntoCalibrate() {
            const deviceControls = document.getElementById('deviceControlsToMerge');
            const calibrationTab = document.getElementById('tabContent-calibrate');
            const profileSelector = deviceControls.firstElementChild;
            const customDimensions = document.getElementById('customInputsBlock-device');
            const diagonalControl = document.getElementById('diagonalControl');
            const ppiControl = document.getElementById('ppiControl');
            const duplicateCustomDimensions = document.getElementById('customInputsBlock-calibrate');

            if (duplicateCustomDimensions) duplicateCustomDimensions.remove();

            const scaleControls = document.createElement('div');
            scaleControls.className = 'border-t border-neutral-800/50 pt-3 space-y-4';
            scaleControls.innerHTML = '<h4 class="text-xs font-bold uppercase text-emerald-400">Ruler Scale</h4>';
            diagonalControl.classList.remove('border-t', 'pt-3');
            ppiControl.classList.remove('border-t', 'pt-3');
            scaleControls.append(diagonalControl, ppiControl);

            // The profile selector and editable scale readouts replace the retired
            // Device tab controls. Online matching is intentionally onboarding-only.
            calibrationTab.prepend(profileSelector, scaleControls);
            deviceControls.remove();
        }

        function mountDeviceDropdown() {
            const list = document.getElementById('deviceDropdownList');
            if (list.parentElement !== document.body) document.body.appendChild(list);
            list.style.position = 'fixed';
            list.style.zIndex = '100';
        }

        function positionDeviceDropdown() {
            const input = document.getElementById('deviceSearchInput');
            const list = document.getElementById('deviceDropdownList');
            const rect = input.getBoundingClientRect();
            list.style.left = rect.left + 'px';
            list.style.width = rect.width + 'px';
            list.style.right = 'auto';
            list.style.top = 'auto';
            // Open upward from the field, outside the scrollable settings card.
            list.style.bottom = Math.max(8, window.innerHeight - rect.top + 6) + 'px';
        }

        function showDeviceDropdown(visible) {
            const list = document.getElementById('deviceDropdownList');
            if (visible) {
                filterDevicePresets(document.getElementById('deviceSearchInput').value);
                mountDeviceDropdown();
                positionDeviceDropdown();
                list.classList.remove('hidden');
            }
            else setTimeout(() => list.classList.add('hidden'), 200);
        }

        function matchesDeviceSearch(name, query) {
            return scoreDeviceSearch({ name }, query) >= 0;
        }

        function scoreDeviceSearch(preset, query) {
            const queryTerms = query.toLowerCase().match(/[a-z0-9]+/g) || [];
            if (!queryTerms.length) return 0;
            const searchableText = getPresetSearchText(preset).toLowerCase();
            const nameTerms = searchableText.match(/[a-z0-9]+/g) || [];
            let score = 0;
            for (const term of queryTerms) {
                const foundAt = nameTerms.findIndex(nameTerm =>
                    nameTerm.startsWith(term) ||
                    (nameTerm.length >= 4 && term.startsWith(nameTerm))
                );
                if (foundAt < 0) return -1;
                const matchingTerm = nameTerms[foundAt];
                score += matchingTerm === term ? 250 : (matchingTerm.startsWith(term) ? 125 : 75);
                score -= foundAt * 0.01;
            }

            const compactQuery = normaliseModelText(query);
            const compactPresetName = normaliseModelText(preset.name.replace(/\s*\([^)]*\)\s*$/, ''));
            const compactAliases = (MODEL_ALIASES_BY_PRESET.get(preset.name) || []).map(normaliseModelText);
            const retailTerms = preset.name.toLowerCase().match(/[a-z0-9]+/g) || [];
            const specificQueryTerms = queryTerms.filter(term => /^(?:[a-z]\d+|\d+)$/i.test(term));
            const variantTerms = new Set(['plus', 'ultra', 'pro', 'fe', 'lite', 'max', 'mini']);
            const queryNamesVariant = queryTerms.some(term => variantTerms.has(term));
            const presetNamesVariant = /\+/.test(preset.name) || retailTerms.some(term => variantTerms.has(term));
            specificQueryTerms.forEach(term => {
                const retailMatch = retailTerms.indexOf(term);
                if (retailMatch < 0) return;
                score += 1000;
                if (!queryNamesVariant && presetNamesVariant) {
                    score -= 600;
                }
            });
            if (compactAliases.some(alias => alias === compactQuery)) score += 10000;
            else if (compactAliases.some(alias => compactQuery.startsWith(alias) || alias.startsWith(compactQuery))) score += 7000;
            else if (compactPresetName === compactQuery) score += 9000;
            else if (compactPresetName.includes(compactQuery)) score += 1500;
            return score;
        }

        function getBestDevicePresetMatches(query, limit = 100) {
            if (!(query || '').trim()) return PRESETS.slice(0, limit);
            return PRESETS
                .map((preset, index) => ({ preset, index, score: scoreDeviceSearch(preset, query) }))
                .filter(match => match.score >= 0)
                .sort((a, b) => b.score - a.score || a.index - b.index)
                .slice(0, limit)
                .map(match => match.preset);
        }

        function filterDevicePresets(query) {
            const list = document.getElementById('deviceDropdownList');
            list.innerHTML = '';
            
            const filtered = getBestDevicePresetMatches(query);
            
            filtered.forEach(p => {
                const div = document.createElement('div');
                div.className = "px-3 py-2.5 hover:bg-neutral-800 cursor-pointer text-sm border-b border-neutral-800/40 text-neutral-200 transition-colors flex justify-between items-center";
                div.innerText = p.name;
                
                if (p.name === activePresetName) {
                    const badge = document.createElement('span');
                    badge.className = "text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded font-bold uppercase tracking-wider";
                    badge.innerText = "Active";
                    div.appendChild(badge);
                }

                div.addEventListener('click', () => {
                    document.getElementById('deviceSearchInput').value = p.name;
                    applyPreset(p.name);
                    list.classList.add('hidden');
                });
                list.appendChild(div);
            });

            const customDiv = document.createElement('div');
            customDiv.className = "px-3 py-2.5 hover:bg-neutral-800 cursor-pointer text-sm text-emerald-400 font-semibold transition-colors";
            customDiv.innerText = "🔍 Custom Device (Override Size)";
            customDiv.addEventListener('click', () => {
                document.getElementById('deviceSearchInput').value = "Custom Override Selection";
                applyPreset("CUSTOM_DEVICE");
                list.classList.add('hidden');
            });
            list.appendChild(customDiv);
            loadCommunityTemplateSearchResults(query, list, customDiv);
        }

        function appendCommunityTemplateSearchResults(list, customDiv, templates, context = 'settings') {
            templates.forEach(template => {
                const div = document.createElement('div');
                div.className = 'px-3 py-2.5 hover:bg-neutral-800 cursor-pointer text-sm border-b border-neutral-800/40 text-neutral-200 transition-colors';
                div.append(document.createTextNode(`${template.model_hint} (${Number(template.diagonal).toFixed(2)}\") `));
                const tag = document.createElement('span');
                tag.className = 'text-emerald-400 font-semibold';
                tag.textContent = '(community template)';
                div.appendChild(tag);
                div.addEventListener('click', () => {
                    applyCommunityTemplateFromSearch(template, context);
                    list.classList.add('hidden');
                });
                list.insertBefore(div, customDiv);
            });
        }

        async function loadCommunityTemplateSearchResults(query, list, customDiv, context = 'settings') {
            const normalizedQuery = normaliseModelText(query);
            const requestId = ++communityTemplateSearchSequence;
            if (normalizedQuery.length < 3) return;
            const cached = communityTemplateSearchCache.get(normalizedQuery);
            if (cached) {
                appendCommunityTemplateSearchResults(list, customDiv, cached, context);
                return;
            }

            try {
                const response = await fetch(getCalibrationTemplateEndpoint(), {
                    method: 'POST',
                    headers: getSupabaseHeaders(),
                    body: JSON.stringify({ action: 'search', query })
                });
                const result = await response.json();
                const templates = response.ok && Array.isArray(result.templates) ? result.templates : [];
                communityTemplateSearchCache.set(normalizedQuery, templates);
                if (requestId === communityTemplateSearchSequence && list.contains(customDiv)) {
                    appendCommunityTemplateSearchResults(list, customDiv, templates, context);
                }
            } catch (_) {
                // Local presets remain fully usable if the optional community search
                // is unavailable or still loading.
            }
        }

        function handleDeviceSearchInput(value) {
            calibrationTouched = true;
            const typedAlias = String(value || '').trim();
            if (isUsefulCalibrationModel(typedAlias)) {
                hasSessionDeviceNameEdit = true;
                updateCalibrationTemplateSaveControl();
            }
            filterDevicePresets(value);
        }

        function showOnboardDropdown(visible) {
            const list = document.getElementById('onboardDropdownList');
            if (visible) {
                filterOnboardPresets(document.getElementById('onboardSearchInput').value);
                list.classList.remove('hidden');
            }
            else setTimeout(() => list.classList.add('hidden'), 200);
        }

        function filterOnboardPresets(query) {
            const list = document.getElementById('onboardDropdownList');
            list.innerHTML = '';
            
            const filtered = getBestDevicePresetMatches(query);
            
            filtered.forEach(p => {
                const div = document.createElement('div');
                div.className = "px-3 py-2.5 hover:bg-neutral-800 cursor-pointer text-sm border-b border-neutral-800/40 text-neutral-200 transition-colors";
                div.innerText = p.name;
                div.addEventListener('click', () => {
                    document.getElementById('onboardSearchInput').value = p.name;
                    handleOnboardSelect(p.name);
                    list.classList.add('hidden');
                });
                list.appendChild(div);
            });

            const customDiv = document.createElement('div');
            customDiv.className = "px-3 py-2.5 hover:bg-neutral-800 cursor-pointer text-sm text-emerald-400 font-semibold transition-colors";
            customDiv.innerText = "🔍 Custom Device (Override Size)";
            customDiv.addEventListener('click', () => {
                document.getElementById('onboardSearchInput').value = "Custom Override Selection";
                handleOnboardSelect("CUSTOM_DEVICE");
                list.classList.add('hidden');
            });
            list.appendChild(customDiv);
            // Built-in presets render immediately; community templates append as
            // soon as their independent lookup completes.
            loadCommunityTemplateSearchResults(query, list, customDiv, 'onboarding');
        }

        function handleOnboardSelect(val) {
            onboardingOnlineMatchApplied = false;
            onboardingTemplateMatchApplied = false;
        }

        // Custom Sizing Dimension Inputs Logic
        function updateCustomMetric(metric, value) {
            calibrationTouched = true;
            const parsed = parseFloat(value);
            if (isNaN(parsed) || parsed <= 0) return;
            hasSessionRulerScaleEdit = true;

            if (metric === 'width') {
                customWidth = parsed;
            } else if (metric === 'height') {
                customHeight = parsed;
            } else if (metric === 'diagonal') {
                customDiagonal = parsed;
            }

            recalculateCustomPPI();
            updateCustomInputsUI();
        }

        function recalculateCustomPPI() {
            // The canvas is measured in CSS pixels. The custom inputs describe physical
            // resolution, so convert through DPR before turning the diagonal into ruler PPI.
            const dpr = window.devicePixelRatio || 1;
            const diagPx = Math.sqrt((customWidth / dpr) ** 2 + (customHeight / dpr) ** 2);
            ppi = diagPx / customDiagonal;
            diagonal = customDiagonal;

            document.getElementById('diagonalSlider').value = customDiagonal;
            document.getElementById('diagonalDisplay').value = customDiagonal.toFixed(2);
            setFineScaleRange(ppi);
            
            const activeDeviceBadge = document.getElementById('activeDeviceBadge');
            const activeDiagonalBadge = document.getElementById('activeDiagonalBadge');
            if (activeDeviceBadge) activeDeviceBadge.innerText = "Custom Spec";
            if (activeDiagonalBadge) activeDiagonalBadge.innerText = customDiagonal.toFixed(2) + '" Layout';

            safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
            safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
            safeStorage.local.setItem('calibrated_ruler_presetName', "Custom Overridden Size");
            updateCalibrationTemplateSaveControl();
            drawAll();
        }

        function updateCustomInputsUI() {
            document.querySelectorAll('.custom-width-input').forEach(el => el.value = customWidth);
            document.querySelectorAll('.custom-height-input').forEach(el => el.value = customHeight);
            document.querySelectorAll('.custom-diag-input').forEach(el => el.value = customDiagonal.toFixed(2));
            
            const gcd = (a, b) => b ? gcd(b, a % b) : a;
            const divisor = gcd(customWidth, customHeight);
            const aspectStr = divisor > 0 ? `${customWidth / divisor}:${customHeight / divisor}` : "Custom";
            document.querySelectorAll('.custom-aspect-readout').forEach(el => el.innerText = aspectStr);
        }

        function checkPresetMatch(name) {
            const match = PRESETS.find(p => p.name.toLowerCase() === name.toLowerCase());
            const customBlockDev = document.getElementById('customInputsBlock-device');
            const customBlockCal = document.getElementById('customInputsBlock-calibrate');
            
            if (match) {
                if (customBlockDev) customBlockDev.classList.add('hidden');
                if (customBlockCal) customBlockCal.classList.add('hidden');
            } else {
                if (customBlockDev) customBlockDev.classList.remove('hidden');
                if (customBlockCal) customBlockCal.classList.remove('hidden');
                updateCustomInputsUI();
            }
            updateCalibrationTemplateSaveControl();
        }

        function enterMeasuringMode() {
            document.documentElement.setAttribute('data-measuring-mode', 'true');
            if (!areControlsHidden) toggleControls();
            document.getElementById('showSiteIntro').focus();
        }

        function leaveMeasuringMode() {
            if (!areControlsHidden) toggleControls();
            document.documentElement.removeAttribute('data-measuring-mode');
            document.querySelector('#siteIntro button').focus();
        }

        function openCalibrationSetup() {
            calibrationTouched = true;
            calibrationReturnFocus = document.activeElement;
            if (!document.getElementById('onboardSearchInput').value && PRESETS.some(p => p.name === activePresetName)) {
                document.getElementById('onboardSearchInput').value = activePresetName;
            }
            document.getElementById('onboardingModal').classList.remove('opacity-0', 'pointer-events-none');
            document.getElementById('onboardingModal').setAttribute('aria-hidden', 'false');
            initializeBottomAd();
            document.getElementById('onboardSearchInput').focus();
            checkMobileApiCreditAvailability();
        }

        function closeCalibrationSetup() {
            document.getElementById('onboardingModal').classList.add('opacity-0', 'pointer-events-none');
            document.getElementById('onboardingModal').setAttribute('aria-hidden', 'true');
            initializeBottomAd();
            calibrationReturnFocus?.focus();
        }

        document.addEventListener('keydown', event => {
            const modal = document.getElementById('onboardingModal');
            if (modal.classList.contains('opacity-0')) return;
            if (event.key === 'Escape') closeCalibrationSetup();
            if (event.key === 'Tab') {
                const controls = [...modal.querySelectorAll('button, input, a[href]')].filter(el => !el.disabled && el.getClientRects().length);
                const first = controls[0], last = controls[controls.length - 1];
                if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
                else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
        });

        function confirmOnboarding(openCalibrateTab = false) {
            calibrationTouched = true;
            const choice = document.getElementById('onboardSearchInput').value;
            const preserveOnlineMatch = onboardingOnlineMatchApplied || onboardingTemplateMatchApplied;
            if (!preserveOnlineMatch) {
                if (choice === "CUSTOM_DEVICE" || choice === "Custom Override Selection") {
                    diagonal = customDiagonal;
                    activePresetName = "Custom User Device";
                } else {
                    const found = PRESETS.find(p => p.name === choice);
                    if (found) {
                        diagonal = found.diagonal;
                        customDiagonal = found.diagonal;
                        customWidth = found.wMatch;
                        customHeight = found.hMatch;
                        activePresetName = found.name;
                        lastSelectedDeviceName = found.name;
                        scaleReferenceDiagonal = found.diagonal;
                    } else {
                        diagonal = customDiagonal;
                        activePresetName = "Custom Device";
                    }
                }
            }

            if (!preserveOnlineMatch) {
                const sw = window.screen.width || window.innerWidth;
                const sh = window.screen.height || window.innerHeight;
                const cssDiag = Math.sqrt(sw*sw + sh*sh);
                ppi = cssDiag / diagonal;
            }
            onboardingOnlineMatchApplied = false;
            onboardingTemplateMatchApplied = false;

            safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
            safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
            safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);

            closeCalibrationSetup();
            
            applySavedMetrics();
            if (openCalibrateTab) {
                enterMeasuringMode();
                if (areControlsHidden) toggleControls();
                setTab('calibrate');
                showToast("Open the Calibrate tab to fine-tune the ruler.");
            } else {
                showToast("Ruler ready.");
            }
        }

        function applySavedMetrics() {
            document.getElementById('deviceSearchInput').value = activePresetName;
            document.getElementById('diagonalSlider').value = diagonal;
            document.getElementById('diagonalDisplay').value = diagonal.toFixed(2);
            setFineScaleRange(ppi);
            
            const activeDeviceBadge = document.getElementById('activeDeviceBadge');
            const activeDiagonalBadge = document.getElementById('activeDiagonalBadge');
            if (activeDeviceBadge) activeDeviceBadge.innerText = activePresetName.replace(/ \([^)]*\)/, '');
            if (activeDiagonalBadge) activeDiagonalBadge.innerText = diagonal.toFixed(2) + '" Layout';
            
            checkPresetMatch(activePresetName);
            filterDevicePresets('');
            resetCalipers();
            updateDisplayValues();
            drawAll();
        }

        function applyPreset(name) {
            calibrationTouched = true;
            if (name === "CUSTOM_DEVICE" || name === "Custom Override Selection") {
                hasSessionDeviceNameEdit = true;
                checkPresetMatch("CUSTOM_DEVICE");
                updateDiagonalFromSlider(diagonal);
                return;
            }
            const found = PRESETS.find(p => p.name === name);
            if (found) {
                diagonal = found.diagonal;
                customDiagonal = found.diagonal;
                customWidth = found.wMatch;
                customHeight = found.hMatch;
                activePresetName = found.name;
                lastSelectedDeviceName = found.name;
                scaleReferenceDiagonal = found.diagonal;
                
                const sw = window.screen.width || window.innerWidth;
                const sh = window.screen.height || window.innerHeight;
                ppi = Math.sqrt(sw*sw + sh*sh) / diagonal;

                safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
                safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
                safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);

                applySavedMetrics();
            }
        }

        function updateDiagonalFromSlider(val) {
            calibrationTouched = true;
            hasSessionRulerScaleEdit = true;
            diagonal = parseFloat(val);
            customDiagonal = diagonal;
            document.getElementById('diagonalDisplay').value = diagonal.toFixed(2);
            activePresetName = "Custom Overridden Size";
            
            const sw = window.screen.width || window.innerWidth;
            const sh = window.screen.height || window.innerHeight;
            ppi = Math.sqrt(sw*sw + sh*sh) / diagonal;

            setFineScaleRange(ppi);
            
            const activeDeviceBadge = document.getElementById('activeDeviceBadge');
            const activeDiagonalBadge = document.getElementById('activeDiagonalBadge');
            if (activeDeviceBadge) activeDeviceBadge.innerText = "Custom Spec";
            if (activeDiagonalBadge) activeDiagonalBadge.innerText = diagonal.toFixed(2) + '" Layout';

            checkPresetMatch(activePresetName);
            safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
            safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
            safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);
            updateDisplayValues();
            drawAll();
        }

        function updateFromMicroSlider(val) {
            calibrationTouched = true;
            hasSessionRulerScaleEdit = true;
            ppi = parseFloat(val);
            document.getElementById('microScaleDisplay').value = Math.round(ppi);
            activePresetName = "Manually Tuned Mesh";
            
            const sw = window.screen.width || window.innerWidth;
            const sh = window.screen.height || window.innerHeight;
            diagonal = Math.sqrt(sw*sw + sh*sh) / ppi;
            customDiagonal = diagonal;

            document.getElementById('diagonalSlider').value = diagonal.toFixed(2);
            document.getElementById('diagonalDisplay').value = diagonal.toFixed(2);
            
            const activeDiagonalBadge = document.getElementById('activeDiagonalBadge');
            if (activeDiagonalBadge) activeDiagonalBadge.innerText = diagonal.toFixed(2) + '" Layout';

            checkPresetMatch(activePresetName);
            safeStorage.local.setItem('calibrated_ruler_ppi', ppi);
            safeStorage.local.setItem('calibrated_ruler_diagonal', diagonal);
            safeStorage.local.setItem('calibrated_ruler_presetName', activePresetName);
            updateDisplayValues();
            drawAll();
        }

        function commitRulerScale(metric, rawValue) {
            const isPpi = metric === 'ppi';
            const value = parseFloat(rawValue);
            if (!Number.isFinite(value) || value <= 0) {
                showToast('Please enter a positive number.');
                document.getElementById(isPpi ? 'microScaleDisplay' : 'diagonalDisplay').value =
                    isPpi ? Math.round(ppi) : diagonal.toFixed(2);
                return;
            }

            if (isPpi) {
                updateFromMicroSlider(value);
                setFineScaleRange(ppi);
            } else {
                updateDiagonalFromSlider(value);
            }
        }

        function setFineScaleRange(value) {
            const slider = document.getElementById('microSlider');
            const reference = Math.max(0.01, scaleReferenceDiagonal);
            slider.min = '0.01';
            slider.max = (reference * 2).toFixed(2);
            slider.step = '0.01';
            slider.value = Math.max(0.01, Math.min(reference * 2, diagonal)).toFixed(2);
            document.getElementById('microScaleDisplay').value = Math.round(ppi);
        }

        function setInchFormat(value) {
            inchFormat = value === 'decimal' ? 'decimal' : 'fraction';
            safeStorage.local.setItem('calibrated_ruler_inch_format', inchFormat);
            updateDisplayValues();
            drawAll();
        }

        function setRulerUnits(value) {
            rulerUnitOrder = value === 'imperial-primary' ? 'imperial-primary' : 'metric-primary';
            safeStorage.local.setItem('calibrated_ruler_unit_order', rulerUnitOrder);
            drawAll();
        }

        function initBubbleLevel() {
            document.getElementById('bubbleLevelToggleRow').classList.remove('hidden');
            // Keep a centred preview visible on desktops while the level is being designed.
            if (!canUseBubbleLevel) {
                syncBubbleLevelToggles(true);
                bubbleLevelPanel.classList.remove('hidden');
                return;
            }

            // Browsers that already permit orientation data (such as most Android
            // browsers) enable the level as soon as a real sensor sample arrives.
            // iPhone browsers that require a tap simply remain off until tapped.
            window.addEventListener('deviceorientation', autoEnableBubbleLevel, true);
            window.addEventListener('devicemotion', autoEnableBubbleLevel, true);
            window.setTimeout(() => {
                window.removeEventListener('deviceorientation', autoEnableBubbleLevel, true);
                window.removeEventListener('devicemotion', autoEnableBubbleLevel, true);
            }, 2000);
        }

        function syncBubbleLevelToggles(enabled) {
            document.querySelectorAll('#toggleBubbleLevel, #onboardToggleBubbleLevel').forEach(toggle => {
                toggle.checked = enabled;
            });
        }

        function updateOnboardingBubbleLevelControl() {
            // Safari exposes "iPhone" rather than a usable hardware model, but its
            // user-agent reliably identifies the permission-gated iPhone experience.
            if (!/iPhone/i.test(navigator.userAgent)) return;
            const row = document.getElementById('onboardBubbleLevelToggleRow');
            if (!row) return;
            row.classList.remove('hidden');
            row.classList.add('flex');
            syncBubbleLevelToggles(document.getElementById('toggleBubbleLevel').checked);
        }

        function autoEnableBubbleLevel(event) {
            const gravity = event.accelerationIncludingGravity;
            const hasGravity = gravity && [gravity.x, gravity.y, gravity.z].every(Number.isFinite);
            const hasOrientation = Number.isFinite(event.beta) && Number.isFinite(event.gamma);
            if (!hasGravity && !hasOrientation) return;
            window.removeEventListener('deviceorientation', autoEnableBubbleLevel, true);
            window.removeEventListener('devicemotion', autoEnableBubbleLevel, true);
            syncBubbleLevelToggles(true);
            startBubbleLevelListeners();
            bubbleLevelPanel.classList.remove('hidden');
            if (hasGravity) updateBubbleLevelFromMotion(event);
            else updateBubbleLevel(event);
        }

        function startBubbleLevelListeners() {
            if (bubbleLevelListening) return;
            window.addEventListener('devicemotion', updateBubbleLevelFromMotion, true);
            window.addEventListener('deviceorientation', updateBubbleLevel, true);
            bubbleLevelListening = true;
        }

        async function toggleBubbleLevel(enabled) {
            if (!enabled) {
                syncBubbleLevelToggles(false);
                bubbleLevelPanel.classList.add('hidden');
                return;
            }

            // No sensor on this device: retain the centred visual preview.
            if (!canUseBubbleLevel) {
                syncBubbleLevelToggles(true);
                bubbleLevelPanel.classList.remove('hidden');
                return;
            }

            try {
                syncBubbleLevelToggles(true);
                // iOS requires this permission request to be initiated by the toggle tap.
                const requests = [];
                if (typeof window.DeviceOrientationEvent?.requestPermission === 'function') {
                    requests.push(window.DeviceOrientationEvent.requestPermission());
                }
                if (typeof window.DeviceMotionEvent?.requestPermission === 'function') {
                    requests.push(window.DeviceMotionEvent.requestPermission());
                }
                if ((await Promise.all(requests)).some(permission => permission !== 'granted')) {
                    throw new Error('permission denied');
                }

                startBubbleLevelListeners();
                bubbleLevelPanel.classList.remove('hidden');
            } catch (_) {
                syncBubbleLevelToggles(false);
                bubbleLevelPanel.classList.add('hidden');
                showToast('Motion access is needed for the bubble level.');
            }
        }

        function resetBubbleLevelSmoothing() {
            smoothedLevelTilt = null;
            lastLevelSampleAt = 0;
            lastGravitySampleAt = 0;
            bubbleVisualPosition = null;
            bubbleVisualTarget = null;
            if (bubbleVisualFrame) cancelAnimationFrame(bubbleVisualFrame);
            bubbleVisualFrame = null;
        }

        function applyBubbleVisualPosition(position) {
            levelDrift.style.left = position.x + 'px';
            levelDrift.style.top = position.y + 'px';
            levelDrift.style.transform = 'translate(-50%, -50%)';
        }

        function animateBubbleInertia(now) {
            const elapsed = Math.min(50, Math.max(1, now - lastBubbleVisualFrameAt));
            lastBubbleVisualFrameAt = now;
            const blend = 1 - Math.exp(-elapsed / 60);
            bubbleVisualPosition.x += (bubbleVisualTarget.x - bubbleVisualPosition.x) * blend;
            bubbleVisualPosition.y += (bubbleVisualTarget.y - bubbleVisualPosition.y) * blend;
            applyBubbleVisualPosition(bubbleVisualPosition);

            const remaining = Math.hypot(
                bubbleVisualTarget.x - bubbleVisualPosition.x,
                bubbleVisualTarget.y - bubbleVisualPosition.y
            );
            if (remaining > 0.25) {
                bubbleVisualFrame = requestAnimationFrame(animateBubbleInertia);
            } else {
                bubbleVisualPosition = { ...bubbleVisualTarget };
                applyBubbleVisualPosition(bubbleVisualPosition);
                bubbleVisualFrame = null;
            }
        }

        function setBubbleVisualTarget(x, y) {
            bubbleVisualTarget = { x, y };
            if (!bubbleVisualPosition) {
                bubbleVisualPosition = { ...bubbleVisualTarget };
                applyBubbleVisualPosition(bubbleVisualPosition);
                return;
            }
            if (!bubbleVisualFrame) {
                lastBubbleVisualFrameAt = performance.now();
                bubbleVisualFrame = requestAnimationFrame(animateBubbleInertia);
            }
        }

        function getScreenOrientationAngle() {
            const angle = screen.orientation?.angle ?? window.orientation ?? 0;
            return ((Number(angle) % 360) + 360) % 360;
        }

        function withEdgeTubeAngles(tilt) {
            const toDegrees = radians => radians * 180 / Math.PI;
            return {
                ...tilt,
                // Each edge tube has 0 at its midpoint and reaches +/-45 at
                // the corners, where the next edge becomes the active tube.
                edgeForX: toDegrees(Math.atan2(tilt.y, Math.abs(tilt.x))),
                edgeForY: toDegrees(Math.atan2(tilt.x, Math.abs(tilt.y)))
            };
        }

        function getScreenRelativeTilt(beta, gamma) {
            // Convert the browser's Euler angles to gravity on the screen plane.
            // `alpha` (the device's yaw / Z-axis rotation) is intentionally not
            // used. Taking the normal component's magnitude means face-up and
            // face-down are both level rather than reporting a 180° pitch.
            const betaRadians = beta * Math.PI / 180;
            const gammaRadians = gamma * Math.PI / 180;
            const gravityX = Math.sin(gammaRadians);
            const gravityY = -Math.sin(betaRadians) * Math.cos(gammaRadians);
            const normalMagnitude = Math.abs(Math.cos(betaRadians) * Math.cos(gammaRadians));
            const toDegrees = radians => radians * 180 / Math.PI;
            const portraitTilt = {
                x: -toDegrees(Math.atan2(gravityX, normalMagnitude)),
                y: toDegrees(Math.atan2(gravityY, normalMagnitude))
            };

            // DeviceOrientation is measured in the device's portrait axes. Rotate
            // the screen-plane tilt into the axes the person is actually viewing.
            let screenTilt;
            switch (getScreenOrientationAngle()) {
                case 90: screenTilt = { x: portraitTilt.y, y: -portraitTilt.x }; break;
                case 180: screenTilt = { x: -portraitTilt.x, y: -portraitTilt.y }; break;
                case 270: screenTilt = { x: -portraitTilt.y, y: portraitTilt.x }; break;
                default: screenTilt = portraitTilt;
            }
            return withEdgeTubeAngles(screenTilt);
        }

        function getScreenRelativeGravityTilt(x, y, z) {
            // Unlike beta/gamma, the accelerometer gives the gravity vector in
            // the device's fixed X/Y/Z frame. That remains well-behaved when the
            // screen is vertical, where Euler angles become ambiguous.
            const toDegrees = radians => radians * 180 / Math.PI;
            // CSS Y grows down the screen, so invert the device's upward-positive
            // Y axis before mapping it to the visual level.
            const portraitGravity = { x, y: -y, z };
            let screenGravity;

            switch (getScreenOrientationAngle()) {
                case 90: screenGravity = { x: portraitGravity.y, y: -portraitGravity.x, z: portraitGravity.z }; break;
                case 180: screenGravity = { x: -portraitGravity.x, y: -portraitGravity.y, z: portraitGravity.z }; break;
                case 270: screenGravity = { x: -portraitGravity.y, y: portraitGravity.x, z: portraitGravity.z }; break;
                default: screenGravity = portraitGravity;
            }

            const normalMagnitude = Math.abs(screenGravity.z);
            return {
                x: toDegrees(Math.atan2(screenGravity.x, normalMagnitude)),
                y: toDegrees(Math.atan2(screenGravity.y, normalMagnitude)),
                // The gravity direction within the screen plane determines the
                // active edge and the signed travel along that edge.
                edgeForX: toDegrees(Math.atan2(screenGravity.y, Math.abs(screenGravity.x))),
                edgeForY: toDegrees(Math.atan2(screenGravity.x, Math.abs(screenGravity.y)))
            };
        }

        function normaliseBubbleTiltForDevice(tilt) {
            // iPhone motion axes are opposite to the bubble's screen-space
            // convention used by this interface. Invert every signed component
            // before smoothing so the visual movement and its numeric readout
            // always agree.
            if (!/iPhone/i.test(navigator.userAgent)) return tilt;
            const invert = value => Number.isFinite(value) ? -value : value;
            return {
                ...tilt,
                x: invert(tilt.x),
                y: invert(tilt.y),
                edgeForX: invert(tilt.edgeForX),
                edgeForY: invert(tilt.edgeForY)
            };
        }

        function updateBubbleLevel(event) {
            if (event.beta === null || event.gamma === null) return;
            // Prefer the direct gravity vector whenever the browser supplies it.
            // DeviceOrientation is retained only as a compatibility fallback.
            if (performance.now() - lastGravitySampleAt < 350) return;
            updateBubbleLevelFromTilt(getScreenRelativeTilt(event.beta, event.gamma));
        }

        function updateBubbleLevelFromMotion(event) {
            const gravity = event.accelerationIncludingGravity;
            if (!gravity || ![gravity.x, gravity.y, gravity.z].every(Number.isFinite)) return;
            lastGravitySampleAt = performance.now();
            updateBubbleLevelFromTilt(getScreenRelativeGravityTilt(gravity.x, gravity.y, gravity.z));
        }

        function updateBubbleLevelFromTilt(rawTilt) {
            rawTilt = normaliseBubbleTiltForDevice(rawTilt);
            const now = performance.now();
            const tiltKeys = ['x', 'y', 'edgeForX', 'edgeForY'].filter(key => Number.isFinite(rawTilt[key]));
            if (!smoothedLevelTilt || now - lastLevelSampleAt > 1000) {
                smoothedLevelTilt = { ...rawTilt };
            } else {
                // Orientation events can arrive before the first accelerometer
                // event. Seed any newly available edge values before smoothing.
                tiltKeys.forEach(key => {
                    if (!Number.isFinite(smoothedLevelTilt[key])) smoothedLevelTilt[key] = rawTilt[key];
                });
                // A small deadband removes accelerometer chatter without adding
                // the noticeable delay of heavy low-pass filtering.
                const deltas = tiltKeys.map(key => rawTilt[key] - smoothedLevelTilt[key]);
                const largestDelta = Math.max(...deltas.map(Math.abs));
                const smoothingWindow = largestDelta > 4 ? 50 : 95;
                const blend = 1 - Math.exp(-(now - lastLevelSampleAt) / smoothingWindow);
                tiltKeys.forEach((key, index) => {
                    const target = Math.abs(deltas[index]) < 0.75 ? smoothedLevelTilt[key] : rawTilt[key];
                    smoothedLevelTilt[key] += (target - smoothedLevelTilt[key]) * blend;
                });
            }
            lastLevelSampleAt = now;
            const tiltX = smoothedLevelTilt.x;
            const tiltY = smoothedLevelTilt.y;
            const xDominant = Math.abs(tiltX) >= Math.abs(tiltY);
            const axisTilt = xDominant ? tiltX : tiltY;
            const edgeTilt = xDominant
                ? (smoothedLevelTilt.edgeForX ?? tiltY)
                : (smoothedLevelTilt.edgeForY ?? tiltX);
            Object.values(levelArcs).forEach(arc => arc.classList.add('hidden'));
            let x;
            let y;

            if (Math.abs(axisTilt) > 45) {
                // Past 45° the screen edge becomes the tube: the bubble's centre
                // is exactly on that edge, while the edge angle rolls along it.
                const direction = xDominant
                    ? (axisTilt > 0 ? 'right' : 'left')
                    : (axisTilt > 0 ? 'bottom' : 'top');
                if (xDominant) {
                    x = direction === 'right' ? window.innerWidth : 0;
                    y = Math.max(0, Math.min(window.innerHeight, window.innerHeight / 2 + edgeTilt / 45 * window.innerHeight / 2));
                    levelArcs[direction].style.left = x + 'px';
                    levelArcs[direction].style.top = (window.innerHeight / 2) + 'px';
                } else {
                    x = Math.max(0, Math.min(window.innerWidth, window.innerWidth / 2 + edgeTilt / 45 * window.innerWidth / 2));
                    y = direction === 'bottom' ? window.innerHeight : 0;
                    levelArcs[direction].style.left = (window.innerWidth / 2) + 'px';
                    levelArcs[direction].style.top = y + 'px';
                }
                levelArcs[direction].classList.remove('hidden');
                // Once the bubble is in an edge tube, its offset along that edge
                // is the only meaningful level reading. The edge target is 0°.
                const edgeDegrees = Math.round(edgeTilt);
                levelReadout.textContent = `${edgeDegrees >= 0 ? '+' : ''}${edgeDegrees}°`;
            } else {
                // Within 45° both axes are meaningful and the bubble rolls toward
                // the equal-sized central alignment circle.
                x = window.innerWidth / 2 + tiltX / 45 * window.innerWidth / 2;
                y = window.innerHeight / 2 + tiltY / 45 * window.innerHeight / 2;
                const xDegrees = Math.round(tiltX);
                const yDegrees = Math.round(tiltY);
                levelReadout.textContent = `X ${xDegrees >= 0 ? '+' : ''}${xDegrees}°\nY ${yDegrees >= 0 ? '+' : ''}${yDegrees}°`;
            }

            setBubbleVisualTarget(
                Math.max(0, Math.min(window.innerWidth, x)),
                Math.max(0, Math.min(window.innerHeight, y))
            );

            const vectorX = x - window.innerWidth / 2;
            const vectorY = y - window.innerHeight / 2;
            const needleAngle = (Math.abs(vectorX) < 0.5 && Math.abs(vectorY) < 0.5)
                ? -90
                : Math.atan2(vectorY, vectorX) * 180 / Math.PI;
            const needleRadians = needleAngle * Math.PI / 180;
            levelNeedle.style.left = `calc(50% + ${31 * Math.cos(needleRadians)}px)`;
            levelNeedle.style.top = `calc(50% + ${31 * Math.sin(needleRadians)}px)`;
            levelNeedle.style.transform = `translateY(-50%) rotate(${needleAngle}deg)`;
        }

        function toggleCalibration(state) { showCalibration = state; drawAll(); }
        function toggleCaliperVisibility(state) {
            showCalipers = state;
            if (state) {
                showProtractor = false;
                document.getElementById('toggleProtractor').checked = false;
            }
            drawAll();
        }
        function toggleProtractor(state) {
            showProtractor = state;
            if (state) {
                showCalipers = false;
                document.getElementById('toggleCalipers').checked = false;
            }
            drawAll();
        }
        function setGridType(type) { showGrid = type; drawAll(); }
        
        function setTab(tab) {
            activeTab = tab;
            ['calibrate', 'guides', 'theme'].forEach(t => {
                const el = document.getElementById(`tabContent-${t}`);
                const btn = document.getElementById(`tabBtn-${t}`);
                if (t === tab) {
                    el.classList.remove('hidden');
                    btn.classList.remove('border-transparent');
                    btn.classList.add('border-emerald-500', 'text-white');
                } else {
                    el.classList.add('hidden');
                    btn.classList.remove('border-emerald-500', 'text-white');
                    btn.classList.add('border-transparent');
                }
            });
            const shareBlock = document.getElementById('saveCalibrationTemplateBlock');
            if (shareBlock?.dataset.available === 'true') {
                shareBlock.classList.toggle('hidden', tab !== 'calibrate' || !navigator.onLine);
            }
            window.requestAnimationFrame(positionSettingsCard);
        }

        function setTheme(theme) {
            currentTheme = theme;
            const readoutPanel = document.getElementById('readoutPanel');
            const card = document.getElementById('settingsCard');
            document.body.className = "h-full overflow-hidden select-none transition-colors duration-300";

            const panelBase = "hidden pointer-events-auto backdrop-blur-md border rounded-2xl p-4 shadow-2xl flex flex-col gap-2 min-w-[280px] max-w-sm transition-all duration-300";
            const cardBase = "pointer-events-auto backdrop-blur-lg border rounded-2xl w-full lg:w-96 max-h-[50vh] lg:max-h-none overflow-hidden shadow-2xl flex flex-col transition-all duration-300";

            let panelTheme = "";
            let cardTheme = "";

            if (theme === 'dark') {
                document.body.classList.add('bg-neutral-950', 'text-white');
                panelTheme = "bg-neutral-900/90 border-neutral-800 text-white";
                cardTheme = "bg-neutral-900/95 border-neutral-800 text-white";
            } else if (theme === 'blueprint') {
                document.body.classList.add('blueprint', 'bg-indigo-950', 'text-indigo-100');
                panelTheme = "bg-indigo-900/90 border-indigo-700/50 text-indigo-100";
                cardTheme = "bg-indigo-900/95 border-indigo-700/50 text-indigo-100";
            } else {
                document.body.classList.add('light', 'bg-neutral-50', 'text-neutral-800');
                panelTheme = "bg-white/95 border-neutral-200 text-neutral-800";
                cardTheme = "bg-white/95 border-neutral-200 text-neutral-800";
            }

            readoutPanel.className = `${panelBase} ${panelTheme}`;
            card.className = `${cardBase} ${cardTheme}`;

            if (areControlsHidden) {
                card.classList.add('translate-y-12', 'scale-95', 'opacity-0', 'pointer-events-none');
                card.classList.remove('translate-y-0', 'scale-100', 'opacity-100');
                readoutPanel.classList.add('opacity-0', 'pointer-events-none');
            } else {
                card.classList.remove('translate-y-12', 'scale-95', 'opacity-0', 'pointer-events-none');
                card.classList.add('translate-y-0', 'scale-100', 'opacity-100');
                readoutPanel.classList.remove('opacity-0', 'pointer-events-none');
            }

            ['dark', 'blueprint', 'light'].forEach(t => {
                const btn = document.getElementById(`themeBtn-${t}`);
                if (btn) {
                    if (t === theme) {
                        btn.classList.add('border-emerald-500');
                        btn.classList.remove('border-transparent');
                    } else {
                        btn.classList.remove('border-emerald-500');
                        btn.classList.add('border-transparent');
                    }
                }
            });

            const adContainer = document.getElementById('bottomAdContainer');
            if (adContainer && !adContainer.classList.contains('hidden')) {
                document.body.classList.add('ad-visible');
                updateBottomAdAnchor();
                syncRulerAdSpace();
            }

            if (!areControlsHidden) window.requestAnimationFrame(positionSettingsCard);
            drawAll();
        }

        function toggleControls() {
            areControlsHidden = !areControlsHidden;
            if (!areControlsHidden) document.documentElement.setAttribute('data-measuring-mode', 'true');
            const card = document.getElementById('settingsCard');
            const readoutPanel = document.getElementById('readoutPanel');
            const greeting = document.getElementById('greetingContainer');

            // While hidden, keep invisible controls below the caliper handles so
            // the full ruler is immediately draggable again.
            appControlsOverlay.classList.toggle('z-40', !areControlsHidden);
            appControlsOverlay.classList.toggle('z-10', areControlsHidden);

            if (areControlsHidden) {
                card.classList.add('translate-y-12', 'scale-95', 'opacity-0', 'pointer-events-none');
                card.classList.remove('translate-y-0', 'scale-100', 'opacity-100');
                rulerToggleIcon.style.transform = "rotate(45deg)";
                readoutPanel.classList.add('opacity-0', 'pointer-events-none');
                greeting.classList.add('opacity-0', 'pointer-events-none');
            } else {
                card.classList.remove('translate-y-12', 'scale-95', 'opacity-0', 'pointer-events-none');
                card.classList.add('translate-y-0', 'scale-100', 'opacity-100');
                rulerToggleIcon.style.transform = "none";
                readoutPanel.classList.remove('opacity-0', 'pointer-events-none');
                greeting.classList.remove('opacity-0', 'pointer-events-none');
                window.requestAnimationFrame(positionSettingsCard);
            }
            if (areControlsHidden) restoreSettingsButtonPosition();
        }

        function hideBottomAdForVisit() {
            const adContainer = document.getElementById('bottomAdContainer');
            if (!adContainer || adContainer.classList.contains('hidden')) return;
            safeStorage.session.setItem(AD_DISMISSED_SESSION_KEY, 'true');
            adContainer.classList.add('hidden');
            document.body.classList.remove('ad-visible');
            syncRulerAdSpace();
            showToast('Ad hidden for this visit.');
        }

        function getAdReservedEdges() {
            const adContainer = document.getElementById('bottomAdContainer');
            const edges = { top: 0, right: 0, bottom: 0, left: 0 };
            const isAdVisible = document.body.classList.contains('ad-visible') &&
                adContainer && !adContainer.classList.contains('hidden');
            if (!isAdVisible) return edges;

            const rect = adContainer.getBoundingClientRect();
            const gap = 8;
            if (document.body.classList.contains('ad-anchor-top')) edges.top = Math.ceil(rect.height + gap);
            if (document.body.classList.contains('ad-anchor-right')) edges.right = Math.ceil(rect.width + gap);
            if (document.body.classList.contains('ad-anchor-bottom')) edges.bottom = Math.ceil(rect.height + gap);
            if (document.body.classList.contains('ad-anchor-left')) edges.left = Math.ceil(rect.width + gap);
            return edges;
        }

        function getSettingsButtonBounds() {
            const reservedEdges = getAdReservedEdges();
            return {
                left: SETTINGS_BUTTON_MARGIN + reservedEdges.left,
                top: SETTINGS_BUTTON_MARGIN + reservedEdges.top,
                right: Math.max(
                    SETTINGS_BUTTON_MARGIN + reservedEdges.left,
                    window.innerWidth - reservedEdges.right - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_MARGIN
                ),
                bottom: Math.max(
                    SETTINGS_BUTTON_MARGIN + reservedEdges.top,
                    window.innerHeight - reservedEdges.bottom - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_MARGIN
                )
            };
        }

        function setSettingsButtonPosition(x, y, persist = false) {
            const bounds = getSettingsButtonBounds();
            const clampedX = Math.max(bounds.left, Math.min(bounds.right, x));
            const clampedY = Math.max(bounds.top, Math.min(bounds.bottom, y));
            toggleControlsBtn.style.left = `${clampedX}px`;
            toggleControlsBtn.style.top = `${clampedY}px`;
            toggleControlsBtn.style.right = 'auto';
            toggleControlsBtn.style.bottom = 'auto';

            if (persist) {
                const xRange = Math.max(1, bounds.right - bounds.left);
                const yRange = Math.max(1, bounds.bottom - bounds.top);
                safeStorage.local.setItem(SETTINGS_BUTTON_POSITION_KEY, JSON.stringify({
                    x: (clampedX - bounds.left) / xRange,
                    y: (clampedY - bounds.top) / yRange
                }));
            }
        }

        function restoreSettingsButtonPosition() {
            const bounds = getSettingsButtonBounds();
            let savedPosition = null;
            try {
                savedPosition = JSON.parse(safeStorage.local.getItem(SETTINGS_BUTTON_POSITION_KEY));
            } catch (_) {
                savedPosition = null;
            }
            const xRange = Math.max(0, bounds.right - bounds.left);
            const yRange = Math.max(0, bounds.bottom - bounds.top);
            const x = savedPosition && Number.isFinite(savedPosition.x)
                ? bounds.left + Math.max(0, Math.min(1, savedPosition.x)) * xRange
                : bounds.right;
            const y = savedPosition && Number.isFinite(savedPosition.y)
                ? bounds.top + Math.max(0, Math.min(1, savedPosition.y)) * yRange
                : bounds.bottom;
            setSettingsButtonPosition(x, y);
        }

        function positionSettingsCard() {
            if (areControlsHidden) return;

            const bounds = getSettingsButtonBounds();
            const reservedEdges = getAdReservedEdges();
            const usableLeft = SETTINGS_BUTTON_MARGIN + reservedEdges.left;
            const usableTop = SETTINGS_BUTTON_MARGIN + reservedEdges.top;
            const usableRight = window.innerWidth - SETTINGS_BUTTON_MARGIN - reservedEdges.right;
            const usableBottom = bounds.bottom + SETTINGS_BUTTON_SIZE;
            const usableHeight = Math.max(160, usableBottom - usableTop);
            const usableWidth = Math.max(160, usableRight - usableLeft);
            const cardWidth = Math.min(384, usableWidth);
            settingsCard.style.position = 'fixed';
            settingsCard.style.width = `${cardWidth}px`;
            // Keep the panel compact enough to make its scroll affordance useful,
            // while still respecting the available space around the settings cog.
            const compactHeight = Math.round(window.innerHeight * 0.60);
            settingsCard.style.maxHeight = `${Math.max(120, Math.min(
                usableHeight - SETTINGS_BUTTON_SIZE - SETTINGS_BUTTON_GAP,
                compactHeight
            ))}px`;
            settingsCard.style.margin = '0';
            settingsCard.style.visibility = 'hidden';
            settingsCard.style.left = '0px';
            settingsCard.style.top = '0px';

            const cardHeight = settingsCard.offsetHeight;
            let buttonRect = toggleControlsBtn.getBoundingClientRect();
            let cardTop;
            if (buttonRect.top - SETTINGS_BUTTON_GAP - cardHeight >= usableTop) {
                cardTop = buttonRect.top - SETTINGS_BUTTON_GAP - cardHeight;
            } else if (buttonRect.bottom + SETTINGS_BUTTON_GAP + cardHeight <= usableBottom) {
                cardTop = buttonRect.bottom + SETTINGS_BUTTON_GAP;
            } else {
                const pushedDownY = usableTop + cardHeight + SETTINGS_BUTTON_GAP;
                if (pushedDownY <= bounds.bottom) {
                    setSettingsButtonPosition(buttonRect.left, pushedDownY);
                    buttonRect = toggleControlsBtn.getBoundingClientRect();
                    cardTop = usableTop;
                } else {
                    const pushedUpY = Math.max(usableTop, usableBottom - cardHeight - SETTINGS_BUTTON_GAP - SETTINGS_BUTTON_SIZE);
                    setSettingsButtonPosition(buttonRect.left, pushedUpY);
                    buttonRect = toggleControlsBtn.getBoundingClientRect();
                    cardTop = buttonRect.bottom + SETTINGS_BUTTON_GAP;
                }
            }

            const cardLeft = Math.max(usableLeft, Math.min(
                usableRight - cardWidth,
                buttonRect.left + SETTINGS_BUTTON_SIZE / 2 - cardWidth / 2
            ));
            settingsCard.style.left = `${cardLeft}px`;
            settingsCard.style.top = `${cardTop}px`;
            settingsCard.style.visibility = 'visible';
        }

        function positionSettingsUI() {
            restoreSettingsButtonPosition();
            if (!areControlsHidden) window.requestAnimationFrame(positionSettingsCard);
        }

        function clearSettingsHoldTimers() {
            window.clearTimeout(settingsHideTimer);
            window.clearTimeout(settingsUnlockTimer);
            window.clearTimeout(settingsLiftTimer);
            settingsHideTimer = null;
            settingsUnlockTimer = null;
            settingsLiftTimer = null;
        }

        function startSettingsHold(event) {
            event.preventDefault();
            settingsHoldHandled = false;
            settingsButtonPointerId = event.pointerId;
            settingsButtonPressPoint = { x: event.clientX, y: event.clientY };
            settingsButtonDragging = false;
            settingsButtonLifted = false;
            clearSettingsHoldTimers();
            toggleControlsBtn.setPointerCapture(event.pointerId);
            settingsLiftTimer = window.setTimeout(() => {
                settingsButtonLifted = true;
                toggleControlsBtn.classList.add('is-lifted');
            }, SETTINGS_BUTTON_LIFT_MS);
            settingsHideTimer = window.setTimeout(() => {
                settingsHoldHandled = true;
                hideBottomAdForVisit();
            }, SETTINGS_HIDE_HOLD_MS);
            settingsUnlockTimer = window.setTimeout(() => {
                settingsHoldHandled = true;
                unlockAdPreference();
            }, SETTINGS_UNLOCK_HOLD_MS);
        }

        function moveSettingsButton(event) {
            if (event.pointerId !== settingsButtonPointerId || !settingsButtonLifted) return;
            const distance = Math.hypot(event.clientX - settingsButtonPressPoint.x, event.clientY - settingsButtonPressPoint.y);
            if (!settingsButtonDragging && distance < SETTINGS_BUTTON_DRAG_THRESHOLD) return;
            if (!settingsButtonDragging) {
                settingsButtonDragging = true;
                settingsHoldHandled = true;
                clearSettingsHoldTimers();
                toggleControlsBtn.classList.add('is-dragging');
            }
            setSettingsButtonPosition(event.clientX - SETTINGS_BUTTON_SIZE / 2, event.clientY - SETTINGS_BUTTON_SIZE / 2);
            if (!areControlsHidden) positionSettingsCard();
            event.preventDefault();
        }

        function stopSettingsHold(event) {
            if (settingsButtonPointerId !== null && event.pointerId !== settingsButtonPointerId) return;
            clearSettingsHoldTimers();
            if (settingsButtonDragging) {
                const rect = toggleControlsBtn.getBoundingClientRect();
                setSettingsButtonPosition(rect.left, rect.top, true);
                showToast('Settings button repositioned.');
            }
            toggleControlsBtn.classList.remove('is-lifted', 'is-dragging');
            if (settingsButtonPointerId !== null && toggleControlsBtn.hasPointerCapture(settingsButtonPointerId)) {
                toggleControlsBtn.releasePointerCapture(settingsButtonPointerId);
            }
            settingsButtonPointerId = null;
            settingsButtonPressPoint = null;
            settingsButtonLifted = false;
            settingsButtonDragging = false;
        }

        function isAdsDisabled() {
            return safeStorage.local.getItem(ADS_DISABLED_KEY) === 'true';
        }

        function syncAdPreferenceUI() {
            const isUnlocked = safeStorage.local.getItem(AD_SETTINGS_UNLOCKED_KEY) === 'true';
            const preferenceRow = document.getElementById('adPreferenceRow');
            const disableToggle = document.getElementById('disableAdsToggle');
            preferenceRow.classList.toggle('hidden', !isUnlocked);
            preferenceRow.classList.toggle('flex', isUnlocked);
            disableToggle.checked = isAdsDisabled();
        }

        function unlockAdPreference() {
            safeStorage.local.setItem(AD_SETTINGS_UNLOCKED_KEY, 'true');
            syncAdPreferenceUI();
            if (areControlsHidden) toggleControls();
            setTab('guides');
            showToast('Ads control unlocked in Tools.');
        }

        function setAdsDisabled(disabled) {
            safeStorage.local.setItem(ADS_DISABLED_KEY, String(disabled));
            if (disabled) {
                const adContainer = document.getElementById('bottomAdContainer');
                adContainer.classList.add('hidden');
                document.body.classList.remove('ad-visible');
                syncRulerAdSpace();
                showToast('Ads disabled on this device.');
            } else {
                safeStorage.session.removeItem(AD_DISMISSED_SESSION_KEY);
                initializeBottomAd();
                showToast('Ads enabled on this device.');
            }
        }

        function initializeBottomAd() {
            const adContainer = document.getElementById('bottomAdContainer');
            const modal = document.getElementById('onboardingModal');
            const contentReady = document.documentElement.hasAttribute('data-ruler-ready');
            const setupOpen = !modal.classList.contains('opacity-0');
            if (!contentReady || setupOpen || adContainer.dataset.loadFailed === 'true' || document.documentElement.hasAttribute('data-ruler-failed')) {
                adContainer.classList.add('hidden');
                document.body.classList.remove('ad-visible');
                if (contentReady) syncRulerAdSpace();
                return;
            }
            const config = window.SCREEN_RULER_CONFIG || {};
            const client = config.adsenseClient;
            const slot = config.bottomAdSlot;
            const hasAdSenseIds = /^ca-pub-\d+$/.test(client || '') && /^\d+$/.test(slot || '');

            if (!hasAdSenseIds || safeStorage.session.getItem(AD_DISMISSED_SESSION_KEY) === 'true') return;

            const adSlot = document.getElementById('bottomAdSlot');
            if (isAdsDisabled()) {
                adContainer.classList.add('hidden');
                document.body.classList.remove('ad-visible');
                syncRulerAdSpace();
                return;
            }
            if (!navigator.onLine) {
                hideBottomBannerForOffline(adContainer);
                return;
            }

            if (adContainer.dataset.initialized === 'true') {
                adContainer.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
                document.body.classList.add('ad-visible');
                updateBottomAdAnchor();
                syncRulerAdSpace();
                return;
            }

            adSlot.dataset.adClient = client;
            adSlot.dataset.adSlot = slot;
            adContainer.classList.remove('hidden');
            adContainer.classList.remove('opacity-0', 'pointer-events-none');
            document.body.classList.add('ad-visible');
            updateBottomAdAnchor();
            syncRulerAdSpace();
            adContainer.dataset.initialized = 'true';

            try {
                if (!document.getElementById('adsenseScript')) {
                    const script = document.createElement('script');
                    script.id = 'adsenseScript';
                    script.async = true;
                    script.crossOrigin = 'anonymous';
                    script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=' + encodeURIComponent(client);
                    script.onerror = () => {
                        adContainer.dataset.loadFailed = 'true';
                        adContainer.classList.add('hidden');
                        document.body.classList.remove('ad-visible');
                        syncRulerAdSpace();
                    };
                    document.head.appendChild(script);
                }
                (window.adsbygoogle = window.adsbygoogle || []).push({});
            } catch (error) {
                adContainer.dataset.loadFailed = 'true';
                adContainer.classList.add('hidden');
                document.body.classList.remove('ad-visible');
                syncRulerAdSpace();
                console.warn('Unable to initialize the bottom ad.', error);
            }
        }

        function hideBottomBannerForOffline(adContainer) {
            adContainer.classList.add('hidden');
            document.body.classList.remove('ad-visible');
            syncRulerAdSpace();
        }

        function updateBottomAdAnchor() {
            const angle = Number(screen.orientation?.angle ?? window.orientation ?? 0);
            const normalizedAngle = ((angle % 360) + 360) % 360;
            const isMobilePhone = /iPhone|iPod|Android.*Mobile|\bMobile\b/i.test(navigator.userAgent);
            const isCompactTouchScreen = isMobilePhone && window.matchMedia('(pointer: coarse)').matches &&
                Math.min(window.innerWidth, window.innerHeight) < 700;
            const physicalAnchorClasses = {
                0: 'ad-anchor-bottom',
                90: 'ad-anchor-right',
                180: 'ad-anchor-top',
                270: 'ad-anchor-left'
            };
            const anchorClass = isCompactTouchScreen
                ? (physicalAnchorClasses[normalizedAngle] || 'ad-anchor-bottom')
                : 'ad-anchor-bottom';

            document.body.classList.remove('ad-anchor-bottom', 'ad-anchor-left', 'ad-anchor-top', 'ad-anchor-right');
            document.body.classList.add(anchorClass);
            window.requestAnimationFrame(() => {
                syncRulerAdSpace();
                positionSettingsUI();
            });
        }

        function getRulerViewportSize() {
            const adContainer = document.getElementById('bottomAdContainer');
            const reservesBottomSpace = document.body.classList.contains('ad-visible') &&
                document.body.classList.contains('ad-anchor-bottom') &&
                adContainer && !adContainer.classList.contains('hidden');
            const adSpace = reservesBottomSpace
                ? Math.ceil(adContainer.getBoundingClientRect().height + 8)
                : 0;
            return {
                width: window.innerWidth,
                height: Math.max(1, window.innerHeight - adSpace)
            };
        }

        function syncRulerAdSpace() {
            const { height } = getRulerViewportSize();
            const adSpace = Math.max(0, window.innerHeight - height);
            document.body.style.setProperty('--ruler-ad-space', `${adSpace}px`);
            resizeCanvas();
            drawAll();
        }

        toggleControlsBtn.addEventListener('pointerdown', startSettingsHold);
        toggleControlsBtn.addEventListener('pointermove', moveSettingsButton);
        toggleControlsBtn.addEventListener('pointerup', stopSettingsHold);
        toggleControlsBtn.addEventListener('pointercancel', stopSettingsHold);
        toggleControlsBtn.addEventListener('pointerleave', stopSettingsHold);
        toggleControlsBtn.addEventListener('contextmenu', event => event.preventDefault());
        toggleControlsBtn.addEventListener('click', () => {
            if (settingsHoldHandled) {
                settingsHoldHandled = false;
                return;
            }
            toggleControls();
        });

        function toggleMinimizeReadouts() {
            const content = document.getElementById('readoutContent');
            const restoreBtn = document.getElementById('restoreReadoutsBtn');
            content.classList.toggle('hidden');
            restoreBtn.classList.toggle('hidden');
        }

        function viewportPointToPhysical(point, angle, viewport) {
            switch (angle) {
                case 90: return { x: viewport.height - point.y, y: point.x };
                case 180: return { x: viewport.width - point.x, y: viewport.height - point.y };
                case 270: return { x: point.y, y: viewport.width - point.x };
                default: return { x: point.x, y: point.y };
            }
        }

        function physicalPointToViewport(point, angle, viewport) {
            switch (angle) {
                case 90: return { x: point.y, y: viewport.height - point.x };
                case 180: return { x: viewport.width - point.x, y: viewport.height - point.y };
                case 270: return { x: viewport.width - point.y, y: point.x };
                default: return { x: point.x, y: point.y };
            }
        }

        function capturePhysicalCaliperPoint(point, name) {
            const viewport = getRulerViewportSize();
            const physicalPoint = viewportPointToPhysical(point, getScreenOrientationAngle(), viewport);
            if (name === 'A') physicalPointA = physicalPoint;
            else physicalPointB = physicalPoint;
        }

        function projectCalipersIntoViewport(width, height) {
            const viewport = { width, height };
            const angle = getScreenOrientationAngle();
            if (!physicalPointA) physicalPointA = viewportPointToPhysical(pointA, angle, viewport);
            if (!physicalPointB) physicalPointB = viewportPointToPhysical(pointB, angle, viewport);
            pointA = physicalPointToViewport(physicalPointA, angle, viewport);
            pointB = physicalPointToViewport(physicalPointB, angle, viewport);
        }

        function resizeCanvas() {
            const { width, height } = getRulerViewportSize();
            projectCalipersIntoViewport(width, height);
            const dpr = window.devicePixelRatio || 1;
            canvas.width = width * dpr;
            canvas.height = height * dpr;
            canvas.style.width = width + 'px';
            canvas.style.height = height + 'px';
            ctx.scale(dpr, dpr);

            updateDisplayValues();
        }

        function resetCalipers() {
            const { width, height } = getRulerViewportSize();
            pointA = { x: Math.round(width * 0.35), y: Math.round(height * 0.35) };
            pointB = { x: Math.round(width * 0.65), y: Math.round(height * 0.65) };
            capturePhysicalCaliperPoint(pointA, 'A');
            capturePhysicalCaliperPoint(pointB, 'B');
            updateDisplayValues();
            drawAll();
        }

        // The handles are ordinary buttons placed over the canvas. This avoids all
        // canvas hit-testing ambiguity: a pressed handle owns its pointer until release.
        function getCaliperVisibleBounds(width, height, inset = 0) {
            const reservedEdges = getAdReservedEdges();
            const bottomInset = document.body.classList.contains('ad-anchor-bottom')
                ? 0
                : reservedEdges.bottom;
            const left = Math.min(width / 2, reservedEdges.left + inset);
            const right = Math.max(left, width - reservedEdges.right - inset);
            const top = Math.min(height / 2, reservedEdges.top + inset);
            const bottom = Math.max(top, height - bottomInset - inset);
            return { left, right, top, bottom };
        }

        function getOffscreenCaliperProxy(point, width, height) {
            const visibleBounds = getCaliperVisibleBounds(width, height);
            const isOffscreen = point.x < visibleBounds.left || point.x > visibleBounds.right ||
                point.y < visibleBounds.top || point.y > visibleBounds.bottom;
            if (!isOffscreen) return null;

            const proxyBounds = getCaliperVisibleBounds(width, height, 30);
            return {
                x: Math.max(proxyBounds.left, Math.min(proxyBounds.right, point.x)),
                y: Math.max(proxyBounds.top, Math.min(proxyBounds.bottom, point.y))
            };
        }

        function syncCaliperHandles() {
            const { width, height } = getRulerViewportSize();
            const handles = [[caliperHandleA, pointA], [caliperHandleB, pointB]];
            handles.forEach(([handle, point]) => {
                const proxy = getOffscreenCaliperProxy(point, width, height);
                const visiblePoint = proxy || point;
                handle.style.left = visiblePoint.x + 'px';
                handle.style.top = visiblePoint.y + 'px';
                handle.classList.toggle('offscreen-proxy', Boolean(proxy));
                if (proxy) {
                    handle.dataset.proxyX = String(proxy.x);
                    handle.dataset.proxyY = String(proxy.y);
                    handle.setAttribute('aria-label', `Bring ${handle === caliperHandleA ? 'green' : 'amber'} caliper back on screen`);
                    handle.title = 'Drag this faint marker to bring the off-screen caliper back here.';
                } else {
                    delete handle.dataset.proxyX;
                    delete handle.dataset.proxyY;
                    handle.setAttribute('aria-label', `Move ${handle === caliperHandleA ? 'green' : 'amber'} caliper`);
                    handle.title = `Drag to move the ${handle === caliperHandleA ? 'green' : 'amber'} caliper. Arrow keys move it precisely.`;
                }
                handle.classList.toggle('hidden', !showCalipers);
            });

            const guides = [
                [caliperGuideAX, pointA.x, 'left'], [caliperGuideAY, pointA.y, 'top'],
                [caliperGuideBX, pointB.x, 'left'], [caliperGuideBY, pointB.y, 'top']
            ];
            guides.forEach(([guide, coordinate, property]) => {
                guide.style[property] = coordinate + 'px';
                guide.classList.toggle('hidden', !showCalipers);
            });
        }

        function getProtractorGeometry() {
            const { width: w, height: h } = getRulerViewportSize();
            const vertical = h > w;
            const radius = vertical
                ? Math.max(92, Math.min(h * 0.42, w * 0.62, 390))
                : Math.max(92, Math.min(w * 0.42, h * 0.36, 270));
            const cx = vertical ? 0 : w / 2;
            const cy = vertical ? h / 2 : h;
            return { radius, cx, cy, vertical };
        }

        function getProtractorGuidePoint(angle) {
            const { radius, cx, cy, vertical } = getProtractorGeometry();
            const radians = angle * Math.PI / 180;
            return vertical
                ? { x: cx + Math.sin(radians) * radius, y: cy + Math.cos(radians) * radius }
                : { x: cx + Math.cos(radians) * radius, y: cy - Math.sin(radians) * radius };
        }

        function syncProtractorHandles() {
            [[protractorHandleA, protractorAngleA], [protractorHandleB, protractorAngleB]].forEach(([handle, angle]) => {
                const point = getProtractorGuidePoint(angle);
                handle.style.left = point.x + 'px';
                handle.style.top = point.y + 'px';
                handle.classList.toggle('hidden', !showProtractor);
            });
        }

        function beginCaliperDrag(which, e) {
            if (!showCalipers || activePointerId !== null) return;
            const point = which.startsWith('A') ? pointA : pointB;
            if (which.endsWith('BOTH') && e.currentTarget.classList.contains('offscreen-proxy')) {
                point.x = Number(e.currentTarget.dataset.proxyX);
                point.y = Number(e.currentTarget.dataset.proxyY);
                capturePhysicalCaliperPoint(point, which.startsWith('A') ? 'A' : 'B');
                updateDisplayValues();
            }
            activePoint = which;
            activePointerId = e.pointerId;
            caliperDraggedThisInteraction = false;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
            drawAll();
        }

        function moveCaliperDrag(e) {
            if (!activePoint || e.pointerId !== activePointerId) return;
            const point = activePoint.startsWith('A') ? pointA : pointB;
            if (activePoint.endsWith('BOTH') || activePoint.endsWith('_X')) {
                point.x = Math.max(0, Math.min(getRulerViewportSize().width, e.clientX));
            }
            if (activePoint.endsWith('BOTH') || activePoint.endsWith('_Y')) {
                point.y = Math.max(0, Math.min(getRulerViewportSize().height, e.clientY));
            }
            capturePhysicalCaliperPoint(point, activePoint.startsWith('A') ? 'A' : 'B');
            caliperDraggedThisInteraction = true;
            e.preventDefault();
            updateDisplayValues();
            drawAll();
        }

        function finishCaliperDrag(e) {
            if (!activePoint || e.pointerId !== activePointerId) return;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            activePoint = null;
            activePointerId = null;
            if (caliperDraggedThisInteraction) {
                ignoreNextClick = true;
                setTimeout(() => { ignoreNextClick = false; }, 150);
            }
            drawAll();
        }

        function nudgeCaliper(which, e) {
            const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
            if (!offsets[e.key]) return;
            const point = which.startsWith('A') ? pointA : pointB;
            const step = e.shiftKey ? 10 : 1;
            if (which.endsWith('BOTH') || which.endsWith('_X')) {
                point.x = Math.max(0, Math.min(getRulerViewportSize().width, point.x + offsets[e.key][0] * step));
            }
            if (which.endsWith('BOTH') || which.endsWith('_Y')) {
                point.y = Math.max(0, Math.min(getRulerViewportSize().height, point.y + offsets[e.key][1] * step));
            }
            capturePhysicalCaliperPoint(point, which.startsWith('A') ? 'A' : 'B');
            e.preventDefault();
            updateDisplayValues();
            drawAll();
        }

        function beginProtractorDrag(which, e) {
            if (!showProtractor || activeProtractorPointerId !== null) return;
            activeProtractorGuide = which;
            activeProtractorPointerId = e.pointerId;
            e.currentTarget.setPointerCapture(e.pointerId);
            e.preventDefault();
            e.stopPropagation();
        }

        function moveProtractorDrag(e) {
            if (!activeProtractorGuide || e.pointerId !== activeProtractorPointerId) return;
            const { cx, cy, vertical } = getProtractorGeometry();
            const angle = vertical
                ? Math.atan2(Math.max(0, e.clientX - cx), e.clientY - cy) * 180 / Math.PI
                : Math.atan2(Math.max(0, cy - e.clientY), e.clientX - cx) * 180 / Math.PI;
            if (activeProtractorGuide === 'A') protractorAngleA = Math.round(angle);
            else protractorAngleB = Math.round(angle);
            e.preventDefault();
            drawAll();
        }

        function finishProtractorDrag(e) {
            if (!activeProtractorGuide || e.pointerId !== activeProtractorPointerId) return;
            if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
            activeProtractorGuide = null;
            activeProtractorPointerId = null;
            drawAll();
        }

        function nudgeProtractor(which, e) {
            if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
            const step = e.shiftKey ? 10 : 1;
            const change = e.key === 'ArrowLeft' ? step : -step;
            if (which === 'A') protractorAngleA = Math.max(0, Math.min(180, protractorAngleA + change));
            else protractorAngleB = Math.max(0, Math.min(180, protractorAngleB + change));
            e.preventDefault();
            drawAll();
        }

        [[caliperHandleA, 'A_BOTH'], [caliperHandleB, 'B_BOTH']].forEach(([handle, which]) => {
            handle.addEventListener('pointerdown', e => beginCaliperDrag(which, e));
            handle.addEventListener('pointermove', moveCaliperDrag);
            handle.addEventListener('pointerup', finishCaliperDrag);
            handle.addEventListener('pointercancel', finishCaliperDrag);
            handle.addEventListener('keydown', e => nudgeCaliper(which, e));
        });

        [[caliperGuideAX, 'A_X'], [caliperGuideAY, 'A_Y'], [caliperGuideBX, 'B_X'], [caliperGuideBY, 'B_Y']].forEach(([guide, which]) => {
            guide.addEventListener('pointerdown', e => beginCaliperDrag(which, e));
            guide.addEventListener('pointermove', moveCaliperDrag);
            guide.addEventListener('pointerup', finishCaliperDrag);
            guide.addEventListener('pointercancel', finishCaliperDrag);
            guide.addEventListener('keydown', e => nudgeCaliper(which, e));
        });

        [[protractorHandleA, 'A'], [protractorHandleB, 'B']].forEach(([handle, which]) => {
            handle.addEventListener('pointerdown', e => beginProtractorDrag(which, e));
            handle.addEventListener('pointermove', moveProtractorDrag);
            handle.addEventListener('pointerup', finishProtractorDrag);
            handle.addEventListener('pointercancel', finishProtractorDrag);
            handle.addEventListener('keydown', e => nudgeProtractor(which, e));
        });

        function updateDisplayValues() {
            const ppm = ppi / 25.4;
            const dx = Math.abs(pointA.x - pointB.x);
            const dy = Math.abs(pointA.y - pointB.y);

            document.getElementById('caliperX_mm').innerText = Math.round(dx / ppm) + ' mm';
            document.getElementById('caliperX_in').innerText = formatInches(dx / ppi);
            document.getElementById('caliperY_mm').innerText = Math.round(dy / ppm) + ' mm';
            document.getElementById('caliperY_in').innerText = formatInches(dy / ppi);
        }

        function formatInches(value) {
            if (inchFormat === 'decimal') return value.toFixed(2) + '"';

            const denominator = 16;
            let whole = Math.floor(value);
            let numerator = Math.round((value - whole) * denominator);
            if (numerator === denominator) { whole += 1; numerator = 0; }
            if (!numerator) return whole + '"';

            const gcd = (a, b) => b ? gcd(b, a % b) : a;
            const divisor = gcd(numerator, denominator);
            const fraction = `${numerator / divisor}/${denominator / divisor}`;
            return (whole ? `${whole}-${fraction}` : fraction) + '"';
        }

        function drawAll() {
            const { width: w, height: h } = getRulerViewportSize();
            ctx.clearRect(0, 0, w, h);

            // OLED Onyx: retain a true black field, while giving the fine grid and
            // minor ruler divisions enough contrast to remain useful outdoors.
            let bgColor = '#000000', lineMajor = 'rgba(255,255,255,0.4)', lineMinor = 'rgba(255,255,255,0.30)', lineSub = 'rgba(255,255,255,0.14)';
            let labelC = '#e5e5e5', gridMaj = 'rgba(16,185,129,0.08)', gridMin = 'rgba(16,185,129,0.035)';

            if (currentTheme === 'blueprint') {
                bgColor = '#0a192f'; lineMajor = 'rgba(255,255,255,0.5)'; lineMinor = 'rgba(255,255,255,0.3)'; lineSub = 'rgba(255,255,255,0.15)';
                labelC = '#fff'; gridMaj = 'rgba(6,182,212,0.15)'; gridMin = 'rgba(6,182,212,0.04)';
            } else if (currentTheme === 'light') {
                bgColor = '#ffffff'; lineMajor = 'rgba(0,0,0,0.6)'; lineMinor = 'rgba(0,0,0,0.4)'; lineSub = 'rgba(0,0,0,0.2)';
                labelC = '#171717'; gridMaj = 'rgba(37,99,235,0.06)'; gridMin = 'rgba(37,99,235,0.02)';
            }

            ctx.fillStyle = bgColor; ctx.fillRect(0, 0, w, h);
            drawRulerGrid(w, h, gridMaj, gridMin);
            drawReferenceOutline(w, h);
            drawBoundaryMarkings(w, h, lineMajor, lineMinor, lineSub, labelC);
            if (showCalipers) drawCrosshairCalipers(w, h);
            if (showProtractor) drawProtractorOverlay(w, h);
            syncCaliperHandles();
            syncProtractorHandles();
            scheduleCanvasMirror();
        }

        // Copying the frame out costs a few milliseconds, which is far too much to
        // spend inside a caliper drag. Nothing but a crawler ever looks at the
        // mirror, so the first frame is captured at once - a serialisation can
        // arrive at any moment - and every later one waits for the app to go quiet.
        let canvasMirrorTimer = null;
        let hasMirroredOnce = false;
        let hasTracedMirror = false;
        function scheduleCanvasMirror() {
            if (!canvasMirror) return;
            if (!hasMirroredOnce) {
                hasMirroredOnce = true;
                updateCanvasMirror();
                return;
            }
            window.clearTimeout(canvasMirrorTimer);
            canvasMirrorTimer = window.setTimeout(updateCanvasMirror, 400);
        }

        // A form control's live value lives on the element, not in the markup, so
        // a serialised copy of the page shows every field back at its authored
        // default - a blank device box and the wrong ruler scale, beside a ruler
        // drawn to the real one. Writing the state back into the attributes keeps
        // the two agreeing. Each of these is the control's *default*, which a
        // control the visitor has already touched ignores.
        // Every write here is a dom mutation, and this runs on a timer against
        // roughly two dozen controls. Writing only what actually changed keeps a
        // settled page settled, which matters if the crawler is waiting for the
        // dom to go quiet before it serialises.
        function reflectFormStateToAttributes() {
            document.querySelectorAll('input, select, textarea').forEach(field => {
                if (field.type === 'checkbox' || field.type === 'radio') {
                    if (field.hasAttribute('checked') !== field.checked) {
                        field.toggleAttribute('checked', field.checked);
                    }
                } else if (field.tagName === 'SELECT') {
                    Array.from(field.options).forEach(option => {
                        if (option.hasAttribute('selected') !== option.selected) {
                            option.toggleAttribute('selected', option.selected);
                        }
                    });
                } else if (field.tagName === 'TEXTAREA') {
                    if (field.textContent !== field.value) field.textContent = field.value;
                } else if (field.getAttribute('value') !== field.value) {
                    field.setAttribute('value', field.value);
                }
            });
        }

        const CANVAS_MIRROR_MAX_EDGE = 1400;
        function updateCanvasMirror() {
            reflectFormStateToAttributes();
            if (!canvas.width || !canvas.height) return;
            try {
                const cssWidth = parseFloat(canvas.style.width) || canvas.width;
                const cssHeight = parseFloat(canvas.style.height) || canvas.height;
                // The still is only ever read at page scale, so it is exported at
                // css resolution and capped. A full device-pixel copy of a desktop
                // window would add megabytes of base64 to the serialised page.
                const scale = Math.min(1, CANVAS_MIRROR_MAX_EDGE / Math.max(cssWidth, cssHeight));
                const still = document.createElement('canvas');
                still.width = Math.max(1, Math.round(cssWidth * scale));
                still.height = Math.max(1, Math.round(cssHeight * scale));
                still.getContext('2d').drawImage(canvas, 0, 0, still.width, still.height);
                const frame = still.toDataURL('image/png');

                if (canvasMirror) {
                    canvasMirror.src = frame;
                    canvasMirror.style.width = cssWidth + 'px';
                    canvasMirror.style.height = cssHeight + 'px';
                }

                // The same frame goes on the body as well, because the previewer
                // hides individual elements it reads as overlays - it already does
                // this to the settings card - and a ruler that lives in exactly one
                // element is one heuristic away from being a black rectangle again.
                // Nothing can hide the body without hiding the page. Both copies
                // share this one data url, so the page carries no extra encoding
                // work, only the second reference.
                document.body.style.backgroundImage = `url("${frame}")`;
                document.body.style.backgroundRepeat = 'no-repeat';
                document.body.style.backgroundPosition = 'left top';
                document.body.style.backgroundSize = `${cssWidth}px ${cssHeight}px`;
                if (!hasTracedMirror) {
                    hasTracedMirror = true;
                    trace('mirror:' + Math.round(frame.length / 1024) + 'kb');
                }
            } catch (error) {
                // An unreadable canvas only costs the still; the live one is fine.
                trace('mirrorfailed:' + (error && error.name));
            }
        }

        function drawProtractorOverlay(w, h) {
            const { radius, cx, cy, vertical } = getProtractorGeometry();
            const scale = currentTheme === 'light' ? 'rgba(82,82,91,0.9)' : 'rgba(212,212,216,0.78)';
            const minor = currentTheme === 'light' ? 'rgba(82,82,91,0.5)' : 'rgba(212,212,216,0.44)';
            const fill = currentTheme === 'light' ? 'rgba(82,82,91,0.045)' : 'rgba(212,212,216,0.06)';
            const colorA = currentTheme === 'light' ? '#059669' : '#10b981';
            const colorB = currentTheme === 'light' ? '#d97706' : '#f59e0b';
            const deltaColor = currentTheme === 'light' ? '#3f3f46' : '#e4e4e7';
            const pointAt = (degree, distance = radius) => {
                const radians = degree * Math.PI / 180;
                return vertical
                    ? { x: cx + Math.sin(radians) * distance, y: cy + Math.cos(radians) * distance }
                    : { x: cx + Math.cos(radians) * distance, y: cy - Math.sin(radians) * distance };
            };
            const edgePointAt = degree => {
                const unit = pointAt(degree, 1);
                const dx = unit.x - cx;
                const dy = unit.y - cy;
                const distances = [];
                if (dx > 0) distances.push((w - cx) / dx);
                if (dx < 0) distances.push(-cx / dx);
                if (dy > 0) distances.push((h - cy) / dy);
                if (dy < 0) distances.push(-cy / dy);
                const distance = Math.min(...distances.filter(value => value > 0));
                return { x: cx + dx * distance, y: cy + dy * distance };
            };
            const drawArc = (from, to, distance) => {
                const first = pointAt(from, distance);
                ctx.beginPath();
                ctx.moveTo(first.x, first.y);
                for (let degree = from + 1; degree <= to; degree++) {
                    const point = pointAt(degree, distance);
                    ctx.lineTo(point.x, point.y);
                }
            };
            const drawArcLabel = (from, to, arcRadius, color, label) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = 2;
                drawArc(from, to, arcRadius);
                ctx.stroke();
                const middle = (from + to) / 2;
                const point = pointAt(middle, arcRadius + 11);
                ctx.font = 'bold 10px monospace';
                const textWidth = ctx.measureText(label).width;
                ctx.fillStyle = currentTheme === 'light' ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.78)';
                ctx.fillRect(point.x - textWidth / 2 - 3, point.y - 7, textWidth + 6, 14);
                ctx.fillStyle = color;
                ctx.fillText(label, point.x, point.y);
            };

            ctx.save();
            ctx.fillStyle = fill;
            drawArc(0, 180, radius);
            ctx.lineTo(cx, cy);
            ctx.closePath();
            ctx.fill();

            ctx.strokeStyle = scale;
            ctx.lineWidth = 1.5;
            drawArc(0, 180, radius);
            ctx.stroke();
            ctx.setLineDash([5, 4]);
            const zeroPoint = pointAt(0);
            const endPoint = pointAt(180);
            ctx.beginPath();
            ctx.moveTo(zeroPoint.x, zeroPoint.y);
            ctx.lineTo(endPoint.x, endPoint.y);
            ctx.stroke();
            ctx.setLineDash([]);

            ctx.font = '10px monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            for (let degree = 0; degree <= 180; degree++) {
                const major = degree % 10 === 0;
                const mid = degree % 5 === 0;
                const tickLength = major ? 13 : (mid ? 9 : 5);
                const outer = pointAt(degree);
                const inner = pointAt(degree, radius - tickLength);
                ctx.strokeStyle = major ? scale : minor;
                ctx.lineWidth = major ? 1.25 : 0.75;
                ctx.beginPath();
                ctx.moveTo(outer.x, outer.y);
                ctx.lineTo(inner.x, inner.y);
                ctx.stroke();
                if (major) {
                    const labelPoint = pointAt(degree, radius - 25);
                    ctx.fillStyle = scale;
                    ctx.fillText(String(degree), labelPoint.x, labelPoint.y);
                }
            }

            // The grey scale stays neutral; the two coloured guides run to the
            // screen edge and use the calipers' crosshair handle treatment.
            [[protractorAngleA, colorA, 'A'], [protractorAngleB, colorB, 'B']].forEach(([degree, color, name]) => {
                const point = pointAt(degree);
                const edge = edgePointAt(degree);
                ctx.strokeStyle = color;
                ctx.lineWidth = activeProtractorGuide === name ? 1.25 : 0.75;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(edge.x, edge.y);
                ctx.stroke();
                ctx.setLineDash([]);

                // Match the caliper points: crosshair, solid centre, and outer ring.
                ctx.beginPath();
                ctx.moveTo(point.x - 20, point.y); ctx.lineTo(point.x + 20, point.y);
                ctx.moveTo(point.x, point.y - 20); ctx.lineTo(point.x, point.y + 20);
                ctx.stroke();
                ctx.beginPath();
                ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
                ctx.fillStyle = activeProtractorGuide === name ? '#ffffff' : color;
                ctx.fill();
                ctx.lineWidth = activeProtractorGuide === name ? 2 : 1.5;
                ctx.beginPath();
                ctx.arc(point.x, point.y, 12, 0, Math.PI * 2);
                ctx.stroke();
                if (activeProtractorGuide === name) {
                    ctx.strokeStyle = color + '33';
                    ctx.lineWidth = 8;
                    ctx.beginPath();
                    ctx.arc(point.x, point.y, 18, 0, Math.PI * 2);
                    ctx.stroke();
                }
                ctx.fillStyle = currentTheme === 'light' ? '#ffffff' : '#111111';
                ctx.font = 'bold 9px monospace';
                ctx.fillStyle = currentTheme === 'light' ? '#171717' : '#ffffff';
                ctx.font = 'bold 10px system-ui, sans-serif';
                ctx.fillText(name, point.x + 16, point.y - 14);
            });

            const difference = Math.abs(protractorAngleA - protractorAngleB);
            drawArcLabel(0, protractorAngleA, radius * 0.28, colorA, `A ${protractorAngleA}°`);
            drawArcLabel(0, protractorAngleB, radius * 0.42, colorB, `B ${protractorAngleB}°`);
            drawArcLabel(Math.min(protractorAngleA, protractorAngleB), Math.max(protractorAngleA, protractorAngleB), radius * 0.56, deltaColor, `A-B ${difference}°`);

            ctx.strokeStyle = scale;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(cx - 9, cy); ctx.lineTo(cx + 9, cy);
            ctx.moveTo(cx, cy - 9); ctx.lineTo(cx, cy + 9);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fillStyle = scale;
            ctx.fill();
            ctx.restore();
        }

        function drawRulerGrid(w, h, majorC, minorC) {
            if (showGrid === 'none') return;
            const ppm = ppi / 25.4;
            const angle = getScreenOrientationAngle();
            const originX = angle === 180 || angle === 270 ? w : 0;
            const originY = angle === 90 || angle === 180 ? h : 0;
            const directionX = originX === 0 ? 1 : -1;
            const directionY = originY === 0 ? 1 : -1;
            const drawGridLines = (spacing, color, lineWidth) => {
                ctx.strokeStyle = color;
                ctx.lineWidth = lineWidth;
                for (let distance = 0; distance <= w; distance += spacing) {
                    const x = originX + directionX * distance;
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                }
                for (let distance = 0; distance <= h; distance += spacing) {
                    const y = originY + directionY * distance;
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
                }
            };

            ctx.save();

            if (showGrid === 'metric' || showGrid === 'both') {
                drawGridLines(5 * ppm, minorC, 0.5);
                drawGridLines(10 * ppm, majorC, 1);
            }
            if (showGrid === 'imperial' || showGrid === 'both') {
                drawGridLines(ppi / 4, minorC, 0.5);
                drawGridLines(ppi, majorC, 1);
            }
            ctx.restore();
        }

        function drawReferenceOutline(w, h) {
            if (!showCalibration) return;
            const ppm = ppi / 25.4;
            const cardW = 85.60 * ppm, cardH = 53.98 * ppm;
            const topCentreY = Math.min(
                h - cardW / 2 - 20,
                Math.max(cardW / 2 + 20, h * 0.22)
            );
            ctx.save();
            ctx.strokeStyle = currentTheme === 'light' ? '#be185d' : (currentTheme === 'blueprint' ? '#fbbf24' : '#ec4899');
            ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
            ctx.translate(w / 2, topCentreY);
            ctx.rotate(Math.PI / 2);
            // Start a fresh path so a line left by another canvas tool cannot be
            // stroked as part of the credit-card outline.
            ctx.beginPath();
            if(ctx.roundRect) ctx.roundRect(-cardW/2, -cardH/2, cardW, cardH, 3.18 * ppm);
            else ctx.rect(-cardW/2, -cardH/2, cardW, cardH);
            ctx.stroke();
            ctx.restore();
        }

        function drawBoundaryMarkings(w, h, majorC, minorC, subMinorC, labelC) {
            const ppm = ppi / 25.4;
            ctx.save(); ctx.font = '9px monospace'; ctx.fillStyle = labelC; ctx.lineWidth = 1;

            const metricOnTopLeft = rulerUnitOrder !== 'imperial-primary';
            const angle = getScreenOrientationAngle();
            const edgeMaps = {
                0: {
                    top: ['top', 1], right: ['right', 1],
                    bottom: ['bottom', 1], left: ['left', 1]
                },
                90: {
                    top: ['left', -1], right: ['top', 1],
                    bottom: ['right', -1], left: ['bottom', 1]
                },
                180: {
                    top: ['bottom', -1], right: ['left', -1],
                    bottom: ['top', -1], left: ['right', -1]
                },
                270: {
                    top: ['right', 1], right: ['bottom', -1],
                    bottom: ['left', 1], left: ['top', -1]
                }
            };
            const mapPhysicalEdge = edge => {
                const [viewportEdge, scaleDirection] = (edgeMaps[angle] || edgeMaps[0])[edge];
                return { edge: viewportEdge, scaleDirection };
            };
            const drawScale = (physicalEdge, unit) => {
                const { edge, scaleDirection } = mapPhysicalEdge(physicalEdge);
                const horizontal = edge === 'top' || edge === 'bottom';
                const length = horizontal ? w : h;
                const edgeCoordinate = edge === 'top' || edge === 'left'
                    ? 0
                    : (horizontal ? h : w);
                const inwardDirection = edge === 'top' || edge === 'left' ? 1 : -1;
                const labelCoordinate = edge === 'top' || edge === 'left'
                    ? 22
                    : edgeCoordinate - 22;
                const step = unit === 'metric' ? ppm : ppi / 16;
                const totalSteps = Math.floor(length / step);

                for (let index = 0; index <= totalSteps; index++) {
                    const distance = index * step;
                    const position = scaleDirection > 0 ? distance : length - distance;
                    const isMajor = unit === 'metric' ? index % 10 === 0 : index % 16 === 0;
                    const isMiddle = unit === 'metric' ? index % 5 === 0 : index % 4 === 0;
                    const tick = unit === 'metric'
                        ? (isMajor ? 18 : (isMiddle ? 12 : 7))
                        : (isMajor ? 18 : (index % 8 === 0 ? 12 : (isMiddle ? 9 : 5)));
                    ctx.strokeStyle = isMajor ? majorC : (isMiddle ? minorC : subMinorC);
                    ctx.beginPath();
                    if (horizontal) {
                        ctx.moveTo(position, edgeCoordinate);
                        ctx.lineTo(position, edgeCoordinate + inwardDirection * tick);
                    } else {
                        ctx.moveTo(edgeCoordinate, position);
                        ctx.lineTo(edgeCoordinate + inwardDirection * tick, position);
                    }
                    ctx.stroke();

                    if (!isMajor || index === 0 || position < 10 || position > length - 10) continue;
                    const label = unit === 'metric' ? String(index / 10) : `${index / 16}"`;
                    ctx.fillStyle = labelC;
                    if (horizontal) {
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(label, position, labelCoordinate);
                    } else {
                        ctx.textAlign = edge === 'left' ? 'left' : 'right';
                        ctx.textBaseline = 'middle';
                        ctx.fillText(label, labelCoordinate, position);
                    }
                }
            };

            const metricHorizontalEdge = metricOnTopLeft ? 'top' : 'bottom';
            const metricVerticalEdge = metricOnTopLeft ? 'left' : 'right';
            const imperialHorizontalEdge = metricOnTopLeft ? 'bottom' : 'top';
            const imperialVerticalEdge = metricOnTopLeft ? 'right' : 'left';
            drawScale(metricHorizontalEdge, 'metric');
            drawScale(metricVerticalEdge, 'metric');
            drawScale(imperialHorizontalEdge, 'imperial');
            drawScale(imperialVerticalEdge, 'imperial');

            ctx.restore();
        }

        function drawCrosshairCalipers(w, h) {
            let colorA = '#10b981'; // Green caliper (Point A)
            let colorB = '#f59e0b'; // Yellow caliper (Point B)
            if (currentTheme === 'light') {
                colorA = '#059669';
                colorB = '#d97706';
            }

            const dx = Math.abs(pointA.x - pointB.x);
            const dy = Math.abs(pointA.y - pointB.y);
            const minX = Math.min(pointA.x, pointB.x);
            const maxX = Math.max(pointA.x, pointB.x);
            const minY = Math.min(pointA.y, pointB.y);
            const maxY = Math.max(pointA.y, pointB.y);

            const ppm = ppi / 25.4;
            const metricOnTopLeft = rulerUnitOrder !== 'imperial-primary';

            // Metric and inch caliper tracks follow the selected ruler sides.
            const mmX = dx / ppm;
            const hLineY1 = metricOnTopLeft ? minY - 30 : maxY + 30;
            ctx.save();
            ctx.strokeStyle = colorA;
            ctx.lineWidth = activePoint === 'A_Y' || activePoint === 'A_BOTH' || activePoint === 'B_BOTH' ? 1.75 : 1;
            ctx.beginPath();
            ctx.moveTo(minX, hLineY1); ctx.lineTo(maxX, hLineY1);
            ctx.moveTo(minX, hLineY1 - 5); ctx.lineTo(minX, hLineY1 + 5);
            ctx.moveTo(maxX, hLineY1 - 5); ctx.lineTo(maxX, hLineY1 + 5);
            ctx.stroke();

            ctx.font = 'bold 10px monospace';
            const labelX_mm = `${Math.round(mmX)} mm`;
            const textW_mm = ctx.measureText(labelX_mm).width;
            ctx.fillStyle = currentTheme === 'light' ? '#ffffff' : '#000000';
            ctx.fillRect(minX + dx/2 - textW_mm/2 - 4, hLineY1 - 7, textW_mm + 8, 14);
            ctx.fillStyle = colorA;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(labelX_mm, minX + dx/2, hLineY1);
            ctx.restore();

            const inX = dx / ppi;
            const hLineY2 = metricOnTopLeft ? maxY + 30 : minY - 30;
            ctx.save();
            ctx.strokeStyle = colorB;
            ctx.lineWidth = activePoint === 'B_Y' || activePoint === 'A_BOTH' || activePoint === 'B_BOTH' ? 1.75 : 1;
            ctx.beginPath();
            ctx.moveTo(minX, hLineY2); ctx.lineTo(maxX, hLineY2);
            ctx.moveTo(minX, hLineY2 - 5); ctx.lineTo(minX, hLineY2 + 5);
            ctx.moveTo(maxX, hLineY2 - 5); ctx.lineTo(maxX, hLineY2 + 5);
            ctx.stroke();

            const labelX_in = formatInches(inX);
            const textW_in = ctx.measureText(labelX_in).width;
            ctx.fillStyle = currentTheme === 'light' ? '#ffffff' : '#000000';
            ctx.fillRect(minX + dx/2 - textW_in/2 - 4, hLineY2 - 7, textW_in + 8, 14);
            ctx.fillStyle = colorB;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(labelX_in, minX + dx/2, hLineY2);
            ctx.restore();

            const mmY = dy / ppm;
            const vLineX1 = metricOnTopLeft ? minX - 30 : maxX + 30;
            ctx.save();
            ctx.strokeStyle = colorA;
            ctx.lineWidth = activePoint === 'A_X' || activePoint === 'A_BOTH' || activePoint === 'B_BOTH' ? 1.75 : 1;
            ctx.beginPath();
            ctx.moveTo(vLineX1, minY); ctx.lineTo(vLineX1, maxY);
            ctx.moveTo(vLineX1 - 5, minY); ctx.lineTo(vLineX1 + 5, minY);
            ctx.moveTo(vLineX1 - 5, maxY); ctx.lineTo(vLineX1 + 5, maxY);
            ctx.stroke();

            const labelY_mm = `${Math.round(mmY)} mm`;
            const textW_Ymm = ctx.measureText(labelY_mm).width;
            ctx.fillStyle = currentTheme === 'light' ? '#ffffff' : '#000000';
            ctx.fillRect(vLineX1 - textW_Ymm/2 - 4, minY + dy/2 - 7, textW_Ymm + 8, 14);
            ctx.fillStyle = colorA;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(labelY_mm, vLineX1, minY + dy/2);
            ctx.restore();

            const inY = dy / ppi;
            const vLineX2 = metricOnTopLeft ? maxX + 30 : minX - 30;
            ctx.save();
            ctx.strokeStyle = colorB;
            ctx.lineWidth = activePoint === 'B_X' || activePoint === 'A_BOTH' || activePoint === 'B_BOTH' ? 1.75 : 1;
            ctx.beginPath();
            ctx.moveTo(vLineX2, minY); ctx.lineTo(vLineX2, maxY);
            ctx.moveTo(vLineX2 - 5, minY); ctx.lineTo(vLineX2 + 5, minY);
            ctx.moveTo(vLineX2 - 5, maxY); ctx.lineTo(vLineX2 + 5, maxY);
            ctx.stroke();

            const labelY_in = formatInches(inY);
            const textW_Yin = ctx.measureText(labelY_in).width;
            ctx.fillStyle = currentTheme === 'light' ? '#ffffff' : '#000000';
            ctx.fillRect(vLineX2 - textW_Yin/2 - 4, minY + dy/2 - 7, textW_Yin + 8, 14);
            ctx.fillStyle = colorB;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(labelY_in, vLineX2, minY + dy/2);
            ctx.restore();

            // Caliper Crosshair Point Markers
            const points = [
                { item: pointA, name: 'A', isActive: activePoint && activePoint.startsWith('A'), color: colorA },
                { item: pointB, name: 'B', isActive: activePoint && activePoint.startsWith('B'), color: colorB }
            ];

            points.forEach(p => {
                ctx.save();
                
                // Track hairlines
                ctx.strokeStyle = currentTheme === 'light'
                    ? (p.isActive ? 'rgba(0,0,0,0.48)' : 'rgba(0,0,0,0.26)')
                    : (p.isActive ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.18)');
                ctx.lineWidth = p.isActive ? 1.25 : 0.75;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(p.item.x, 0); ctx.lineTo(p.item.x, h);
                ctx.moveTo(0, p.item.y); ctx.lineTo(w, p.item.y);
                ctx.stroke();

                ctx.setLineDash([]);
                ctx.strokeStyle = p.color;
                ctx.lineWidth = p.isActive ? 2.5 : 1.5;
                ctx.beginPath();
                ctx.moveTo(p.item.x - 20, p.item.y); ctx.lineTo(p.item.x + 20, p.item.y);
                ctx.moveTo(p.item.x, p.item.y - 20); ctx.lineTo(p.item.x, p.item.y + 20);
                ctx.stroke();

                ctx.fillStyle = p.isActive ? '#ffffff' : p.color;
                ctx.beginPath();
                ctx.arc(p.item.x, p.item.y, 6, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.strokeStyle = p.color;
                ctx.lineWidth = p.isActive ? 2 : 1.5;
                ctx.beginPath();
                ctx.arc(p.item.x, p.item.y, 12, 0, Math.PI * 2);
                ctx.stroke();

                // Highlighted touch boundary rings when active
                if (p.isActive) {
                    ctx.strokeStyle = p.color + '33';
                    ctx.lineWidth = 8;
                    ctx.beginPath();
                    ctx.arc(p.item.x, p.item.y, 18, 0, Math.PI * 2);
                    ctx.stroke();
                }

                ctx.fillStyle = currentTheme === 'light' ? '#171717' : '#ffffff';
                ctx.font = 'bold 10px system-ui, sans-serif';
                ctx.fillText(p.name, p.item.x + 16, p.item.y - 14);

                ctx.restore();
            });

            ctx.save();
            ctx.strokeStyle = currentTheme === 'light' ? 'rgba(0,0,0,0.22)' : 'rgba(255,255,255,0.1)';
            ctx.lineWidth = 1;
            ctx.strokeRect(pointA.x, pointA.y, pointB.x - pointA.x, pointB.y - pointA.y);
            ctx.restore();
        }

        /* ---------------------------------------------------------------
           BIG RULER — AR measuring.

           The distance is read straight off the AR runtime's understanding of
           the room: a ray from the screen centre is hit-tested against mapped
           surfaces, and two of those hits give a Euclidean distance. There is
           no accelerometer integration here on purpose — dead reckoning was
           tried, measured at 10-30% error against a 2% target, and abandoned.
           Because nothing is integrated there is no drift and no need for the
           device to be held still.
           --------------------------------------------------------------- */

        // Kept behind start/getCurrentHit/project/end so the WebXR internals can
        // be swapped for a native ARKit backend without touching the UI layer.
        const bigRulerBackend = (() => {
            let session = null;
            let gl = null;
            let refSpace = null;
            let hitSource = null;
            let frameCallback = null;
            let endCallback = null;
            // Written every frame and read by the UI. Nothing in here triggers a
            // render on its own; see bigRulerMirrorState for why.
            const state = { hit: null, tracking: false, viewProjection: null };

            async function isSupported() {
                if (!window.isSecureContext || !navigator.xr) return false;
                try {
                    return await navigator.xr.isSessionSupported('immersive-ar');
                } catch (_) {
                    return false;
                }
            }

            // Column-major 4x4 multiply, matching the matrix layout WebXR uses:
            // the element at (row, col) lives at m[col * 4 + row].
            function multiply(a, b) {
                const out = new Float32Array(16);
                for (let col = 0; col < 4; col++) {
                    for (let row = 0; row < 4; row++) {
                        let sum = 0;
                        for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
                        out[col * 4 + row] = sum;
                    }
                }
                return out;
            }

            function clearState() {
                state.hit = null;
                state.tracking = false;
                state.viewProjection = null;
            }

            async function start(overlayElement) {
                // hit-test is the entire feature, so it is required rather than
                // optional: better to fail here than to open a session that can
                // never measure anything.
                session = await navigator.xr.requestSession('immersive-ar', {
                    requiredFeatures: ['local', 'hit-test'],
                    optionalFeatures: ['local-floor', 'dom-overlay'],
                    domOverlay: { root: overlayElement }
                });

                // Nothing is ever drawn into WebGL, but a session without a base
                // layer does not produce frames at all.
                const glCanvas = document.createElement('canvas');
                gl = glCanvas.getContext('webgl', { xrCompatible: true, alpha: true, antialias: false });
                if (!gl) throw new Error('WebGL is unavailable');
                await gl.makeXRCompatible();
                session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

                // local-floor puts the origin at floor level; not every device offers it.
                try {
                    refSpace = await session.requestReferenceSpace('local-floor');
                } catch (_) {
                    refSpace = await session.requestReferenceSpace('local');
                }

                // The ray starts at the viewer and points forward, which is what
                // puts the hit squarely at the centre of the screen.
                const viewerSpace = await session.requestReferenceSpace('viewer');
                // requestHitTestSource is async and missing altogether on older
                // implementations. Without it there is nothing to measure, so this
                // fails loudly rather than leaving a session that never finds a
                // surface and looks merely broken.
                hitSource = (await session.requestHitTestSource?.({ space: viewerSpace })) || null;
                if (!hitSource) throw new Error('Hit testing is unavailable');

                // Covers the system back gesture and app switching just as much as
                // our own Exit button.
                session.addEventListener('end', () => {
                    hitSource?.cancel?.();
                    hitSource = null;
                    session = null;
                    gl = null;
                    refSpace = null;
                    clearState();
                    endCallback?.();
                });

                session.requestAnimationFrame(onFrame);
            }

            // Note: session.requestAnimationFrame, not the window one — different
            // clocks, and only this one delivers an XRFrame.
            function onFrame(time, xrFrame) {
                // Re-requested before anything that can return early, so a frame
                // that loses tracking cannot silently kill the loop.
                session.requestAnimationFrame(onFrame);

                // Without this clear the compositor can show garbage over the camera.
                const layer = session.renderState.baseLayer;
                gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
                gl.clearColor(0, 0, 0, 0);
                gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

                const pose = xrFrame.getViewerPose(refSpace);
                if (!pose || pose.views.length === 0) {
                    // Tracking loss is routine in poor light or fast motion. Report
                    // it rather than leaving a stale reading looking current.
                    clearState();
                    frameCallback?.();
                    return;
                }

                state.tracking = true;
                const view = pose.views[0];
                state.viewProjection = multiply(view.projectionMatrix, view.transform.inverse.matrix);

                let hit = null;
                if (hitSource) {
                    const results = xrFrame.getHitTestResults(hitSource);
                    if (results.length > 0) {
                        const hitPose = results[0].getPose(refSpace);
                        if (hitPose) {
                            const p = hitPose.transform.position;
                            hit = { x: p.x, y: p.y, z: p.z };   // metres, world coordinates
                        }
                    }
                }
                state.hit = hit;
                frameCallback?.();
            }

            // Placed points are fixed in the world, so they have to be projected
            // afresh each frame to stay stuck to the real surface.
            function project(point) {
                const vp = state.viewProjection;
                if (!vp) return null;
                const w = vp[3] * point.x + vp[7] * point.y + vp[11] * point.z + vp[15];
                if (w <= 0) return null;   // behind the camera
                const x = vp[0] * point.x + vp[4] * point.y + vp[8] * point.z + vp[12];
                const y = vp[1] * point.x + vp[5] * point.y + vp[9] * point.z + vp[13];
                // CSS pixels, because these numbers position DOM elements. The
                // WebGL layer viewport is in framebuffer pixels and would be out
                // by the device pixel ratio.
                return {
                    x: (x / w / 2 + 0.5) * window.innerWidth,
                    y: (1 - (y / w / 2 + 0.5)) * window.innerHeight
                };
            }

            return {
                isSupported,
                start,
                project,
                end: () => { session?.end?.().catch(() => {}); },
                getCurrentHit: () => state.hit,
                isTracking: () => state.tracking,
                isRunning: () => Boolean(session),
                onFrame: (callback) => { frameCallback = callback; },
                onEnd: (callback) => { endCallback = callback; }
            };
        })();

        // Frame data is mirrored into the text UI on a timer rather than per
        // frame: this runs at display rate over a live camera feed, and updating
        // readouts 60+ times a second drops frames and cooks the phone.
        const BIG_RULER_MIRROR_MS = 100;
        const BIG_RULER_COACH_DELAY_MS = 4000;
        let bigRulerAvailable = false;
        let bigRulerPoints = [];
        let bigRulerMeasurements = [];
        let bigRulerMirrorTimer = null;
        let bigRulerStarting = false;
        let bigRulerLastLive = null;
        let bigRulerLastTracking = null;
        let bigRulerLostHitSince = 0;
        let bigRulerAudioContext = null;
        let bigRulerEls = null;

        function bigRulerElements() {
            if (!bigRulerEls) {
                bigRulerEls = {
                    overlay: document.getElementById('bigRulerOverlay'),
                    reticle: document.getElementById('bigRulerReticle'),
                    pointA: document.getElementById('bigRulerPointA'),
                    pointB: document.getElementById('bigRulerPointB'),
                    line: document.getElementById('bigRulerLine'),
                    liveCard: document.getElementById('bigRulerLiveCard'),
                    livePrimary: document.getElementById('bigRulerLivePrimary'),
                    liveSecondary: document.getElementById('bigRulerLiveSecondary'),
                    status: document.getElementById('bigRulerStatus'),
                    statusDot: document.getElementById('bigRulerStatusDot'),
                    trackingWarning: document.getElementById('bigRulerTrackingWarning'),
                    coach: document.getElementById('bigRulerCoach'),
                    placeBtn: document.getElementById('bigRulerPlaceBtn'),
                    clearBtn: document.getElementById('bigRulerClearBtn'),
                    keepBtn: document.getElementById('bigRulerKeepBtn'),
                    keptPanel: document.getElementById('bigRulerKeptPanel'),
                    keptList: document.getElementById('bigRulerKeptList')
                };
            }
            return bigRulerEls;
        }

        async function initBigRuler() {
            bigRulerAvailable = await bigRulerBackend.isSupported();
            document.getElementById('bigRulerToolRow').classList.toggle('hidden', !bigRulerAvailable);
            document.getElementById('bigRulerUnsupportedRow').classList.toggle('hidden', bigRulerAvailable);
            if (!bigRulerAvailable) return;

            bigRulerBackend.onFrame(drawBigRulerFrame);
            bigRulerBackend.onEnd(closeBigRulerUi);
            // Taps on the overlay controls would otherwise also fire XR select
            // events at whatever the camera is pointed at.
            bigRulerElements().overlay.addEventListener('beforexrselect', (e) => e.preventDefault());
        }

        async function openBigRuler() {
            if (!bigRulerAvailable || bigRulerStarting || bigRulerBackend.isRunning()) return;
            bigRulerStarting = true;

            const els = bigRulerElements();
            bigRulerPoints = [];
            bigRulerLastLive = null;
            bigRulerLastTracking = null;
            bigRulerLostHitSince = 0;
            drawBigRulerKept();

            // The overlay root has to exist and be laid out before requestSession,
            // or the DOM overlay silently never appears. Showing it and waiting two
            // frames gets it through layout while the tap is still fresh enough to
            // count as the user gesture the session needs.
            els.overlay.classList.remove('hidden');
            document.body.classList.add('ar-active');
            bigRulerMirrorState();
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

            try {
                await bigRulerBackend.start(els.overlay);
                bigRulerMirrorTimer = window.setInterval(bigRulerMirrorState, BIG_RULER_MIRROR_MS);
            } catch (error) {
                // Setup can fail after the session opened (no WebGL, no hit-test
                // source), which would otherwise strand a live camera session.
                bigRulerBackend.end();
                closeBigRulerUi();
                showToast(error?.name === 'NotAllowedError'
                    ? 'Camera access is needed for BIG RULER.'
                    : 'BIG RULER could not start on this device.');
            } finally {
                bigRulerStarting = false;
            }
        }

        function exitBigRuler() {
            bigRulerBackend.end();
            // The session's end event drives the teardown, so an exit we did not
            // initiate lands in exactly the same place.
            if (!bigRulerBackend.isRunning()) closeBigRulerUi();
        }

        function closeBigRulerUi() {
            const els = bigRulerElements();
            window.clearInterval(bigRulerMirrorTimer);
            bigRulerMirrorTimer = null;
            document.body.classList.remove('ar-active');
            els.overlay.classList.add('hidden');
            els.pointA.classList.add('hidden');
            els.pointB.classList.add('hidden');
            els.line.classList.add('hidden');
            els.liveCard.classList.add('hidden');
            els.coach.classList.add('hidden');
            bigRulerPoints = [];
        }

        // Runs at display rate. Direct style writes only — cheap, and what keeps
        // the markers glued to the surface as the camera moves.
        function drawBigRulerFrame() {
            const els = bigRulerElements();
            const hit = bigRulerBackend.getCurrentHit();
            const tracking = bigRulerBackend.isTracking();

            const live = Boolean(hit);
            if (live !== bigRulerLastLive) {
                els.reticle.classList.toggle('is-live', live);
                bigRulerLastLive = live;
            }
            if (tracking !== bigRulerLastTracking) {
                els.trackingWarning.classList.toggle('hidden', tracking);
                bigRulerLastTracking = tracking;
            }

            // While measuring, the loose end of the line follows the live hit.
            const first = bigRulerPoints[0] ? bigRulerBackend.project(bigRulerPoints[0]) : null;
            const secondPoint = bigRulerPoints[1] || (bigRulerPoints.length === 1 ? hit : null);
            const second = secondPoint ? bigRulerBackend.project(secondPoint) : null;

            positionBigRulerMarker(els.pointA, first);
            positionBigRulerMarker(els.pointB, bigRulerPoints[1] ? second : null);

            // A point behind the camera projects to a mirrored, meaningless spot,
            // so the line is drawn only when both ends are genuinely in front.
            if (first && second) {
                els.line.setAttribute('x1', first.x);
                els.line.setAttribute('y1', first.y);
                els.line.setAttribute('x2', second.x);
                els.line.setAttribute('y2', second.y);
                els.line.classList.remove('hidden');
            } else {
                els.line.classList.add('hidden');
            }
        }

        function positionBigRulerMarker(element, screenPoint) {
            if (!screenPoint) {
                element.classList.add('hidden');
                return;
            }
            element.style.left = screenPoint.x + 'px';
            element.style.top = screenPoint.y + 'px';
            element.classList.remove('hidden');
        }

        // The ~100ms mirror: everything that costs a layout or a text change.
        function bigRulerMirrorState() {
            const els = bigRulerElements();
            const running = bigRulerBackend.isRunning();
            const hit = bigRulerBackend.getCurrentHit();
            const tracking = bigRulerBackend.isTracking();
            const placed = bigRulerPoints.length;

            let status = 'Starting';
            let dot = 'bg-neutral-500';
            if (running && !tracking) {
                status = 'Tracking lost';
                dot = 'bg-amber-500';
            } else if (running && placed >= 2) {
                status = 'Measurement complete';
                dot = 'bg-emerald-500';
            } else if (running && !hit) {
                status = 'Finding surface';
                dot = 'bg-neutral-500';
            } else if (running && placed === 0) {
                status = 'Tap Place for the first point';
                dot = 'bg-emerald-500';
            } else if (running) {
                status = 'Move to the second point';
                dot = 'bg-emerald-500';
            }
            els.status.textContent = status;
            els.statusDot.className = `w-2 h-2 rounded-full ${dot}`;

            // Live distance while measuring is what makes this feel like a tape
            // measure instead of a two-step form.
            let distance = null;
            if (placed >= 2) distance = bigRulerDistance(bigRulerPoints[0], bigRulerPoints[1]);
            else if (placed === 1 && hit) distance = bigRulerDistance(bigRulerPoints[0], hit);

            if (distance === null) {
                els.liveCard.classList.add('hidden');
            } else {
                els.livePrimary.textContent = formatBigRulerPrimary(distance);
                els.liveSecondary.textContent = formatBigRulerSecondary(distance);
                els.liveCard.classList.remove('hidden');
            }

            els.placeBtn.disabled = !hit;
            els.placeBtn.textContent = placed >= 2 ? 'Measure again' : 'Place';
            els.clearBtn.disabled = placed === 0;
            els.keepBtn.disabled = placed < 2;

            // Coaching after a few fruitless seconds: aiming matters far more than
            // anything the user can do with the buttons.
            if (running && tracking && !hit) {
                if (!bigRulerLostHitSince) bigRulerLostHitSince = performance.now();
                const stalled = performance.now() - bigRulerLostHitSince > BIG_RULER_COACH_DELAY_MS;
                els.coach.classList.toggle('hidden', !stalled);
            } else {
                bigRulerLostHitSince = 0;
                els.coach.classList.add('hidden');
            }
        }

        function placeBigRulerPoint() {
            const hit = bigRulerBackend.getCurrentHit();
            if (!hit) return;
            // A third placement starts a fresh measurement from where you are now.
            if (bigRulerPoints.length >= 2) bigRulerPoints = [hit];
            else bigRulerPoints.push(hit);
            confirmBigRulerPlacement();
            bigRulerMirrorState();
        }

        function clearBigRulerPoints() {
            bigRulerPoints = [];
            bigRulerMirrorState();
        }

        function keepBigRulerMeasurement() {
            if (bigRulerPoints.length < 2) return;
            const [a, b] = bigRulerPoints;
            // The coordinates are only meaningful inside this session — the
            // reference space origin is established at start and lost at the end —
            // so they are kept for diagnostics and the distance is the real result.
            bigRulerMeasurements.unshift({
                id: `br-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                distanceM: bigRulerDistance(a, b),
                a: { ...a },
                b: { ...b },
                capturedAt: new Date().toISOString(),
                truthM: null
            });
            bigRulerPoints = [];
            drawBigRulerKept();
            bigRulerMirrorState();
        }

        function clearBigRulerKept() {
            bigRulerMeasurements = [];
            drawBigRulerKept();
        }

        function drawBigRulerKept() {
            const els = bigRulerElements();
            els.keptPanel.classList.toggle('hidden', bigRulerMeasurements.length === 0);
            els.keptList.textContent = '';

            bigRulerMeasurements.forEach(measurement => {
                const row = document.createElement('div');
                row.className = 'flex items-center justify-between gap-2';

                const value = document.createElement('div');
                value.className = 'font-mono text-sm font-semibold text-white';
                value.textContent = formatBigRulerPrimary(measurement.distanceM);

                const check = document.createElement('div');
                check.className = 'flex items-center gap-1.5';

                const error = document.createElement('span');
                error.className = 'font-mono text-[10px] text-neutral-500 w-12 text-right';
                error.textContent = bigRulerErrorLabel(measurement);

                const truth = document.createElement('input');
                truth.type = 'number';
                truth.step = '0.1';
                truth.min = '0';
                truth.placeholder = 'actual';
                truth.setAttribute('aria-label', 'Tape-measured distance in centimetres');
                truth.className = 'w-20 bg-neutral-950 border border-neutral-800 rounded-lg px-2 py-1 text-right text-[11px] font-mono text-emerald-400 outline-none focus:border-emerald-500';
                if (measurement.truthM !== null) truth.value = (measurement.truthM * 100).toFixed(1);
                truth.oninput = () => {
                    const centimetres = parseFloat(truth.value);
                    measurement.truthM = Number.isFinite(centimetres) && centimetres > 0 ? centimetres / 100 : null;
                    error.textContent = bigRulerErrorLabel(measurement);
                };

                const unit = document.createElement('span');
                unit.className = 'text-[10px] text-neutral-500';
                unit.textContent = 'cm';

                check.append(error, truth, unit);
                row.append(value, check);
                els.keptList.appendChild(row);
            });
        }

        function bigRulerErrorLabel(measurement) {
            if (!measurement.truthM) return '';
            const errorPercent = ((measurement.distanceM - measurement.truthM) / measurement.truthM) * 100;
            return `${errorPercent >= 0 ? '+' : ''}${errorPercent.toFixed(1)}%`;
        }

        // The device is held at arm's length and the user is watching the surface,
        // not the button, so placement confirms without needing to be seen.
        function confirmBigRulerPlacement() {
            navigator.vibrate?.(18);
            try {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                if (!AudioCtx) return;
                bigRulerAudioContext = bigRulerAudioContext || new AudioCtx();
                const now = bigRulerAudioContext.currentTime;
                const oscillator = bigRulerAudioContext.createOscillator();
                const gain = bigRulerAudioContext.createGain();
                oscillator.frequency.value = 880;
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
                oscillator.connect(gain).connect(bigRulerAudioContext.destination);
                oscillator.start(now);
                oscillator.stop(now + 0.13);
            } catch (_) {
                // The confirmation tone is a nicety; never let it break a placement.
            }
        }

        function bigRulerDistance(a, b) {
            return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        }

        // Two significant figures: more digits imply an accuracy hit-testing does
        // not have.
        function bigRulerSignificant(value) {
            if (!Number.isFinite(value) || value === 0) return '0';
            // Rounded first, then the decimal places are taken from the rounded
            // magnitude — otherwise a value like 0.999 crosses a decade while
            // being rounded and prints a third digit as "1.00".
            const rounded = Number(value.toPrecision(2));
            const decimals = Math.min(3, Math.max(0, 1 - Math.floor(Math.log10(Math.abs(rounded)))));
            return rounded.toFixed(decimals);
        }

        // Centimetres below a metre, metres above. The threshold sits just under
        // 1 so a reading that would round to "100 cm" reads "1.0 m" instead.
        function formatBigRulerMetric(metres) {
            return metres < 0.995
                ? `${bigRulerSignificant(metres * 100)} cm`
                : `${bigRulerSignificant(metres)} m`;
        }

        function formatBigRulerImperial(metres) {
            // Rounded to sixteenths first so a remainder of 11.99" cannot print as 12".
            const sixteenths = Math.round((metres / 0.0254) * 16);
            const feet = Math.floor(sixteenths / 192);
            const inches = (sixteenths - feet * 192) / 16;
            return feet ? `${feet}' ${formatInches(inches)}` : formatInches(inches);
        }

        // Follows whichever unit order the on-screen rulers are set to.
        function formatBigRulerPrimary(metres) {
            return rulerUnitOrder === 'imperial-primary'
                ? formatBigRulerImperial(metres)
                : formatBigRulerMetric(metres);
        }

        function formatBigRulerSecondary(metres) {
            return rulerUnitOrder === 'imperial-primary'
                ? formatBigRulerMetric(metres)
                : formatBigRulerImperial(metres);
        }

        function showToast(msg) {
            const toast = document.getElementById('toast');
            document.getElementById('toastMsg').innerText = msg;
            toast.classList.replace('opacity-0', 'opacity-100');
            setTimeout(() => toast.classList.replace('opacity-100', 'opacity-0'), 3000);
        }
