// ==UserScript==
// @name         GitHub PR Conflicts Helper
// @namespace    https://github.com/KrX3D
// @version      2.5.0
// @description  Helper for GitHub PR conflict pages: accept current/incoming for all conflicts in current file, internal live counter, auto-default after 30s, Alt+N next, Alt+B prev, auto mark resolved, auto commit merge, auto continue same choice on next file.
// @match        https://github.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // =========================
    // Settings
    // =========================
    const DEBUG = false;          // true = enable console logs
    const AUTO_SECONDS = 30;
    const CLICK_DELAY_MS = 120;
    const LOOP_DELAY_MS = 220;
    const MAX_BULK_STEPS = 900;
    const LARGE_CONFLICT_SCAN_STEPS = 4;   // how many times to try moving backward when a long conflict gets skipped

    // =========================
    // Constants
    // =========================
    const PANEL_ID = 'krx-gh-conflicts-helper';
    const STYLE_ID = 'krx-gh-conflicts-helper-style';

    let panel = null;
    let countEl = null;
    let statusEl = null;
    let fileStatusEl = null;
    let countdownEl = null;
    let autoMarkResolvedCheckbox = null;
    let autoCommitCheckbox = null;
    let autoContinueCheckbox = null;

    let autoTimer = null;
    let autoDeadline = null;
    let refreshTimer = null;
    let observer = null;
    let urlWatcher = null;
    let observerRoot = null;

    let lastUrl = location.href;
    let lastFileSignature = '';
    let dismissedForCurrentFile = false;
    let bulkActionRunning = false;
    let bulkCancelRequested = false;

    let internalRemaining = null;
    let lastSeenInitialCount = null;

    let autoMarkResolvedEnabled = true;
    let autoCommitEnabled = true;
    let autoContinueEnabled = true;

    let autoMarkResolvedInProgress = false;
    let autoCommitInProgress = false;
    let autoContinueInProgress = false;
    let lastAutoMarkResolvedKey = '';
    let lastAutoCommitKey = '';
    let lastAutoContinueKey = '';

    let lastPickedMode = null;     // 'current' | 'incoming' | null
    let hasPickedMode = false;     // prevents auto-continue from starting immediately on first page load

    const pendingWidgets = new WeakSet();
    const resolvedWidgets = new WeakSet();

    function log(...args) {
        if (DEBUG) console.log('[KrX Conflicts Helper]', ...args);
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function isConflictPage() {
        return /\/pull\/\d+\/conflicts(?:\/?$|[?#])/.test(location.href);
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function getCodeMirrorScroll() {
        return document.querySelector('.CodeMirror-scroll');
    }

    function rememberPickedMode(mode) {
        if (mode === 'current' || mode === 'incoming') {
            lastPickedMode = mode;
            hasPickedMode = true;
            log('rememberPickedMode', mode);
        }
    }

    function scrollButtonFullyIntoEditorView(el) {
        if (!el || !el.isConnected) return;

        const cmScroll = getCodeMirrorScroll();
        if (!cmScroll) {
            try {
                el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            } catch {
                try {
                    el.scrollIntoView({ block: 'center', inline: 'nearest' });
                } catch {}
            }
            return;
        }

        try {
            const btnRect = el.getBoundingClientRect();
            const scRect = cmScroll.getBoundingClientRect();

            const marginTop = 20;
            const marginBottom = 20;

            let delta = 0;

            if (btnRect.top < scRect.top + marginTop) {
                delta = btnRect.top - (scRect.top + marginTop);
            } else if (btnRect.bottom > scRect.bottom - marginBottom) {
                delta = btnRect.bottom - (scRect.bottom - marginBottom);
            }

            if (delta !== 0) {
                cmScroll.scrollTop += delta;
            }
        } catch {}

        try {
            const btnRect2 = el.getBoundingClientRect();
            if (btnRect2.top < 0 || btnRect2.bottom > window.innerHeight) {
                el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
            }
        } catch {}
    }

    function bringWidgetHeaderIntoView(widget) {
        if (!widget || !widget.isConnected) return;

        const currentBtn = [...widget.querySelectorAll('button')]
            .find(btn => normalizeText(btn.textContent) === 'accept current change')
            || widget.querySelector('button');

        if (currentBtn) {
            scrollButtonFullyIntoEditorView(currentBtn);
            return;
        }

        try {
            widget.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'instant' });
        } catch {
            try {
                widget.scrollIntoView({ block: 'start', inline: 'nearest' });
            } catch {}
        }
    }

    function triggerRealClick(el) {
        if (!el || !el.isConnected) return false;

        scrollButtonFullyIntoEditorView(el);

        try {
            el.click();
            return true;
        } catch {}

        try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })); } catch {}
        try { el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); } catch {}
        try { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true })); } catch {}
        try { el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true })); } catch {}

        try {
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            return true;
        } catch {
            return false;
        }
    }

    function getAllButtons() {
        return [...document.querySelectorAll('button')];
    }

    function getEditorElement() {
        return document.querySelector('.CodeMirror-code[contenteditable="true"], #code-editor, .CodeMirror');
    }

    function getConflictCountElement() {
        return document.querySelector('.js-conflict-count');
    }

    function getInitialGitHubConflictCount() {
        const el = getConflictCountElement();
        if (!el) return 0;

        const n = parseInt((el.textContent || '').trim(), 10);
        return Number.isInteger(n) ? n : 0;
    }

    function getRemainingConflictCount() {
        if (isMarkResolvedEnabled()) return 0;
        if (typeof internalRemaining === 'number') return Math.max(0, internalRemaining);
        return getInitialGitHubConflictCount();
    }

    function updateDisplayedCountNow() {
        if (countEl) countEl.textContent = String(getRemainingConflictCount());
    }

    function setInternalRemaining(n) {
        const newValue = Math.max(0, Number.isFinite(n) ? n : 0);
        if (internalRemaining === newValue) return;
        internalRemaining = newValue;
        updateDisplayedCountNow();
        log('setInternalRemaining', internalRemaining);
    }

    function decrementInternalRemaining() {
        if (typeof internalRemaining !== 'number') {
            internalRemaining = getInitialGitHubConflictCount();
        }
        if (internalRemaining > 0) {
            internalRemaining -= 1;
            updateDisplayedCountNow();
            log('decrementInternalRemaining ->', internalRemaining);
        }
    }

    function initializeInternalCountForCurrentFile(force = false) {
        const initial = getInitialGitHubConflictCount();

        if (force || internalRemaining === null) {
            internalRemaining = initial;
            lastSeenInitialCount = initial;
            updateDisplayedCountNow();
            log('initializeInternalCountForCurrentFile ->', initial);
            return;
        }

        if (force || initial !== lastSeenInitialCount) {
            internalRemaining = initial;
            lastSeenInitialCount = initial;
            updateDisplayedCountNow();
            log('reinitializeInternalCountForCurrentFile ->', initial);
        }
    }

    function getNextConflictButton() {
        return document.querySelector('button.js-next-conflict') ||
               document.querySelector('button[aria-label="Next conflict"]') ||
               getAllButtons().find(btn => normalizeText(btn.getAttribute('aria-label') || '') === 'next conflict') ||
               null;
    }

    function getPrevConflictButton() {
        return document.querySelector('button.js-prev-conflict') ||
               document.querySelector('button[aria-label="Previous conflict"]') ||
               getAllButtons().find(btn => normalizeText(btn.getAttribute('aria-label') || '') === 'previous conflict') ||
               null;
    }

    function getMarkResolvedButton() {
        return document.querySelector('button.js-mark-resolved') ||
               getAllButtons().find(btn => normalizeText(btn.textContent) === 'mark as resolved') ||
               null;
    }

    function isMarkResolvedEnabled() {
        const btn = getMarkResolvedButton();
        if (!btn) return false;

        const ariaDisabled = btn.getAttribute('aria-disabled');
        const propDisabled = !!btn.disabled;
        const hasDisabledClass = btn.classList.contains('disabled');

        return ariaDisabled !== 'true' && !propDisabled && !hasDisabledClass;
    }

    function getCommitMergeButton() {
        return document.querySelector('button.js-resolve-conflicts-button') ||
               getAllButtons().find(btn => normalizeText(btn.textContent) === 'commit merge') ||
               null;
    }

    function getVisibleConflictWidgets() {
        const widgets = [...document.querySelectorAll('.CodeMirror-linewidget')];

        return widgets.filter(widget => {
            if (!widget.isConnected || !isVisible(widget)) return false;
            const buttons = [...widget.querySelectorAll('button')];
            const labels = buttons.map(btn => normalizeText(btn.textContent));
            return labels.includes('accept current change') && labels.includes('accept incoming change');
        });
    }

    function getWidgetButtons(widget) {
        if (!widget) return { current: null, incoming: null, both: null };

        const buttons = [...widget.querySelectorAll('button')];
        let current = null;
        let incoming = null;
        let both = null;

        for (const btn of buttons) {
            const text = normalizeText(btn.textContent);
            if (text === 'accept current change') current = btn;
            if (text === 'accept incoming change') incoming = btn;
            if (text === 'accept both changes') both = btn;
        }

        return { current, incoming, both };
    }

    function widgetStillHasConflictButtons(widget) {
        if (!widget || !widget.isConnected || !isVisible(widget)) return false;
        const buttons = [...widget.querySelectorAll('button')];
        const labels = buttons.map(btn => normalizeText(btn.textContent));
        return labels.includes('accept current change') && labels.includes('accept incoming change');
    }

    function getCurrentFileSignature() {
        const filename = document.querySelector('.js-filename')?.textContent?.trim() || '';
        const initial = getInitialGitHubConflictCount();
        const markResolvedEnabled = isMarkResolvedEnabled() ? 'enabled' : 'disabled';
        return `${location.pathname}|${filename}|${initial}|${markResolvedEnabled}`;
    }

    function getAutoActionKey() {
        const filename = document.querySelector('.js-filename')?.textContent?.trim() || '';
        return `${location.pathname}|${filename}`;
    }

    async function monitorWidgetResolution(widget) {
        if (!widget || resolvedWidgets.has(widget) || pendingWidgets.has(widget)) {
            return false;
        }

        pendingWidgets.add(widget);

        try {
            const started = Date.now();
            const wasLast = getRemainingConflictCount() <= 1;

            while (Date.now() - started < 1200) {
                if (bulkCancelRequested) return false;

                if (isMarkResolvedEnabled()) {
                    if (!resolvedWidgets.has(widget)) {
                        resolvedWidgets.add(widget);
                        setInternalRemaining(0);
                    }
                    return true;
                }

                if (!widget || !widget.isConnected || !isVisible(widget) || !widgetStillHasConflictButtons(widget)) {
                    if (!resolvedWidgets.has(widget)) {
                        resolvedWidgets.add(widget);
                        decrementInternalRemaining();
                    }
                    return true;
                }

                await wait(50);
            }

            if (wasLast) {
                return false;
            }

            if (!resolvedWidgets.has(widget)) {
                resolvedWidgets.add(widget);
                decrementInternalRemaining();
            }
            return true;
        } finally {
            pendingWidgets.delete(widget);
        }
    }

    async function autoClickMarkResolvedIfWanted() {
        if (!autoMarkResolvedEnabled || autoMarkResolvedInProgress) return false;
        if (!isConflictPage()) return false;
        if (bulkActionRunning) return false;

        const btn = getMarkResolvedButton();
        if (!btn || !isMarkResolvedEnabled()) return false;

        const key = getAutoActionKey();
        if (lastAutoMarkResolvedKey === key) return false;

        autoMarkResolvedInProgress = true;
        lastAutoMarkResolvedKey = key;

        try {
            setStatus('Auto-clicking Mark as resolved…');
            const ok = triggerRealClick(btn);
            if (ok) {
                await wait(250);
                queueRefresh();
                setTimeout(queueRefresh, 700);
                return true;
            }
            return false;
        } finally {
            autoMarkResolvedInProgress = false;
        }
    }

    async function autoClickCommitMergeIfWanted() {
        if (!autoCommitEnabled || autoCommitInProgress) return false;
        if (!isConflictPage()) return false;

        const btn = getCommitMergeButton();
        if (!btn || !isVisible(btn)) return false;

        const key = `${location.pathname}|commit`;
        if (lastAutoCommitKey === key) return false;

        autoCommitInProgress = true;
        lastAutoCommitKey = key;

        try {
            setStatus('Auto-clicking Commit merge…');
            const ok = triggerRealClick(btn);
            if (ok) {
                await wait(250);
                queueRefresh();
                setTimeout(queueRefresh, 700);
                return true;
            }
            return false;
        } finally {
            autoCommitInProgress = false;
        }
    }

    async function autoContinueSameChoiceIfWanted() {
        if (!autoContinueEnabled || autoContinueInProgress) return false;
        if (!hasPickedMode || !lastPickedMode) return false;
        if (!isConflictPage()) return false;
        if (bulkActionRunning) return false;
        if (dismissedForCurrentFile) return false;
        if (isMarkResolvedEnabled()) return false;
        if (getCommitMergeButton() && isVisible(getCommitMergeButton())) return false;

        const remaining = getRemainingConflictCount();
        if (remaining <= 0) return false;

        const key = getAutoActionKey();
        if (lastAutoContinueKey === key) return false;

        autoContinueInProgress = true;
        lastAutoContinueKey = key;

        try {
            setStatus(`Auto-continuing with ${lastPickedMode} on next file…`);
            await wait(150);
            acceptAll(lastPickedMode, false);
            return true;
        } finally {
            autoContinueInProgress = false;
        }
    }

    function injectStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
            #${PANEL_ID} {
                position: fixed;
                right: 16px;
                bottom: 16px;
                z-index: 999999;
                width: 390px;
                background: #0d1117;
                color: #e6edf3;
                border: 1px solid #30363d;
                border-radius: 10px;
                box-shadow: 0 8px 24px rgba(0,0,0,.4);
                padding: 12px;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
                font-size: 12px;
                line-height: 1.4;
            }
            #${PANEL_ID} .krx-title {
                font-size: 13px;
                font-weight: 600;
                margin-bottom: 6px;
            }
            #${PANEL_ID} .krx-row {
                margin: 5px 0;
            }
            #${PANEL_ID} .krx-count {
                font-weight: 700;
                font-size: 16px;
            }
            #${PANEL_ID} .krx-subtle {
                color: #8b949e;
            }
            #${PANEL_ID} .krx-buttons {
                display: flex;
                gap: 6px;
                flex-wrap: wrap;
                margin-top: 8px;
            }
            #${PANEL_ID} .krx-options {
                margin-top: 8px;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            #${PANEL_ID} .krx-option {
                display: flex;
                align-items: center;
                gap: 8px;
                color: #e6edf3;
            }
            #${PANEL_ID} .krx-option input[type="checkbox"] {
                margin: 0;
                cursor: pointer;
            }
            #${PANEL_ID} button {
                appearance: none;
                border: 1px solid #30363d;
                border-radius: 8px;
                padding: 7px 9px;
                cursor: pointer;
                font-size: 12px;
                font-weight: 600;
                color: #e6edf3;
                background: #21262d;
            }
            #${PANEL_ID} button:hover {
                background: #30363d;
            }
            #${PANEL_ID} .krx-primary {
                background: #238636;
                border-color: #2ea043;
                color: #fff;
            }
            #${PANEL_ID} .krx-secondary {
                background: #1f6feb;
                border-color: #388bfd;
                color: #fff;
            }
            #${PANEL_ID} .krx-divider {
                height: 1px;
                background: #30363d;
                margin: 8px 0;
            }
            #${PANEL_ID} .krx-footer {
                margin-top: 8px;
                font-size: 11px;
                color: #8b949e;
            }
        `;
        document.head.appendChild(style);
    }

    function ensurePanel() {
        if (panel && panel.isConnected) return panel;

        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.innerHTML = `
            <div class="krx-title">GitHub Conflicts Helper</div>
            <div class="krx-row">
                Remaining conflicts in this file: <span class="krx-count">0</span>
            </div>
            <div class="krx-row krx-subtle krx-countdown"></div>
            <div class="krx-divider"></div>
            <div class="krx-row krx-status">Waiting…</div>
            <div class="krx-row krx-file-status krx-subtle"></div>
            <div class="krx-buttons">
                <button class="krx-primary krx-accept-current">Accept current</button>
                <button class="krx-secondary krx-accept-incoming">Accept incoming</button>
                <button class="krx-dismiss">Dismiss</button>
            </div>
            <div class="krx-options">
                <label class="krx-option">
                    <input type="checkbox" class="krx-auto-mark-resolved" checked>
                    <span>Auto-click Mark as resolved</span>
                </label>
                <label class="krx-option">
                    <input type="checkbox" class="krx-auto-commit" checked>
                    <span>Auto-click Commit merge</span>
                </label>
                <label class="krx-option">
                    <input type="checkbox" class="krx-auto-continue" checked>
                    <span>Auto-continue same choice on next file</span>
                </label>
            </div>
            <div class="krx-footer">
                Alt+N = Next conflict · Alt+B = Previous conflict
            </div>
        `;

        document.body.appendChild(panel);

        countEl = panel.querySelector('.krx-count');
        countdownEl = panel.querySelector('.krx-countdown');
        statusEl = panel.querySelector('.krx-status');
        fileStatusEl = panel.querySelector('.krx-file-status');
        autoMarkResolvedCheckbox = panel.querySelector('.krx-auto-mark-resolved');
        autoCommitCheckbox = panel.querySelector('.krx-auto-commit');
        autoContinueCheckbox = panel.querySelector('.krx-auto-continue');

        autoMarkResolvedCheckbox.checked = autoMarkResolvedEnabled;
        autoCommitCheckbox.checked = autoCommitEnabled;
        autoContinueCheckbox.checked = autoContinueEnabled;

        autoMarkResolvedCheckbox.addEventListener('change', () => {
            autoMarkResolvedEnabled = !!autoMarkResolvedCheckbox.checked;
        });

        autoCommitCheckbox.addEventListener('change', () => {
            autoCommitEnabled = !!autoCommitCheckbox.checked;
        });

        autoContinueCheckbox.addEventListener('change', () => {
            autoContinueEnabled = !!autoContinueCheckbox.checked;
        });

        panel.querySelector('.krx-accept-current').addEventListener('click', () => {
            rememberPickedMode('current');
            acceptAll('current', false);
        });
        panel.querySelector('.krx-accept-incoming').addEventListener('click', () => {
            rememberPickedMode('incoming');
            acceptAll('incoming', false);
        });
        panel.querySelector('.krx-dismiss').addEventListener('click', () => {
            dismissedForCurrentFile = true;
            bulkCancelRequested = true;
            stopAutoTimer();
            if (panel) panel.style.display = 'none';
        });

        return panel;
    }

    function setStatus(text) {
        if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
    }

    function setFileStatus(text) {
        if (fileStatusEl && fileStatusEl.textContent !== text) fileStatusEl.textContent = text;
    }

    function stopAutoTimer() {
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
        autoDeadline = null;
        if (countdownEl) countdownEl.textContent = '';
    }

    function updateCountdown() {
        if (!countdownEl || !autoDeadline) return;
        const secs = Math.max(0, Math.ceil((autoDeadline - Date.now()) / 1000));
        countdownEl.textContent = `Auto-accept current in ${secs}s`;
    }

    function startAutoTimer() {
        stopAutoTimer();

        const count = getRemainingConflictCount();
        if (count <= 0 || bulkActionRunning) return;

        autoDeadline = Date.now() + AUTO_SECONDS * 1000;
        updateCountdown();

        autoTimer = setInterval(() => {
            if (!isConflictPage()) {
                stopAutoTimer();
                return;
            }

            const remaining = getRemainingConflictCount();
            if (remaining <= 0 || bulkActionRunning) {
                stopAutoTimer();
                refreshUI();
                return;
            }

            const ms = autoDeadline - Date.now();
            if (ms <= 0) {
                stopAutoTimer();
                rememberPickedMode('current');
                acceptAll('current', true);
                return;
            }

            updateCountdown();
        }, 250);
    }

    async function clickNextConflict() {
        const btn = getNextConflictButton();
        if (!btn) return false;
        return triggerRealClick(btn);
    }

    async function clickPrevConflict() {
        const btn = getPrevConflictButton();
        if (!btn) return false;
        return triggerRealClick(btn);
    }

    async function recoverSkippedLargeConflict(mode) {
        for (let i = 0; i < LARGE_CONFLICT_SCAN_STEPS; i++) {
            const movedBack = await clickPrevConflict();
            if (!movedBack) break;
            await wait(120);

            const widgets = getVisibleConflictWidgets();
            if (!widgets.length) continue;

            const widget = widgets[0];
            bringWidgetHeaderIntoView(widget);
            await wait(50);

            const buttons = getWidgetButtons(widget);
            const target = mode === 'incoming' ? buttons.incoming : buttons.current;

            if (!target) continue;

            scrollButtonFullyIntoEditorView(target);
            await wait(25);

            const ok = triggerRealClick(target);
            if (!ok) continue;

            await wait(CLICK_DELAY_MS);
            const resolved = await monitorWidgetResolution(widget);
            return { clicked: true, resolved };
        }

        return { clicked: false, resolved: false };
    }

    async function clickVisibleConflictChoice(mode) {
        const widgets = getVisibleConflictWidgets();
        if (!widgets.length) return { clicked: false, resolved: false };

        const widget = widgets[0];

        bringWidgetHeaderIntoView(widget);
        await wait(40);

        let buttons = getWidgetButtons(widget);
        let target = mode === 'incoming' ? buttons.incoming : buttons.current;

        if (!target) {
            await clickPrevConflict();
            await wait(60);
            buttons = getWidgetButtons(widget);
            target = mode === 'incoming' ? buttons.incoming : buttons.current;
        }

        if (!target) {
            return recoverSkippedLargeConflict(mode);
        }

        scrollButtonFullyIntoEditorView(target);
        await wait(25);

        let ok = triggerRealClick(target);

        if (!ok) {
            bringWidgetHeaderIntoView(widget);
            await wait(50);
            scrollButtonFullyIntoEditorView(target);
            await wait(25);
            ok = triggerRealClick(target);
        }

        if (!ok) {
            return recoverSkippedLargeConflict(mode);
        }

        await wait(CLICK_DELAY_MS);
        const resolved = await monitorWidgetResolution(widget);

        if (!resolved && getRemainingConflictCount() > 0) {
            // If the widget did not resolve, try scanning backwards for a skipped long conflict
            const recovered = await recoverSkippedLargeConflict(mode);
            if (recovered.clicked) return recovered;
        }

        return { clicked: true, resolved };
    }

    async function acceptAll(mode, fromAuto) {
        if (bulkActionRunning) return;

        rememberPickedMode(mode);
        bulkActionRunning = true;
        bulkCancelRequested = false;
        stopAutoTimer();

        setStatus(
            fromAuto
                ? `Auto-accepting ${mode}…`
                : mode === 'incoming'
                    ? 'Accepting all incoming in this file…'
                    : 'Accepting all current in this file…'
        );

        let clicks = 0;
        let steps = 0;
        let stuckRounds = 0;
        let lastCount = getRemainingConflictCount();

        updateDisplayedCountNow();

        while (steps < MAX_BULK_STEPS) {
            if (bulkCancelRequested) {
                setStatus('Cancelled.');
                break;
            }

            steps++;

            const remaining = getRemainingConflictCount();
            if (remaining <= 0 || isMarkResolvedEnabled()) break;

            const beforeCount = getRemainingConflictCount();
            const result = await clickVisibleConflictChoice(mode);

            if (bulkCancelRequested) {
                setStatus('Cancelled.');
                break;
            }

            if (result.clicked) {
                clicks++;
            } else {
                // try next first
                let moved = await clickNextConflict();
                if (moved) {
                    await wait(LOOP_DELAY_MS);
                } else {
                    // if next is not possible, also try previous to catch skipped long conflicts near the end
                    moved = await clickPrevConflict();
                    if (moved) {
                        await wait(LOOP_DELAY_MS);
                    } else {
                        await wait(120);
                    }
                }
            }

            if (isMarkResolvedEnabled()) {
                setInternalRemaining(0);
                break;
            }

            if (beforeCount <= 1 && getRemainingConflictCount() <= 1) {
                // critical fix:
                // when at the last visible conflict, try moving backward too,
                // because GitHub sometimes leaves the cursor at the bottom while an earlier long conflict is still unresolved
                const movedBack = await clickPrevConflict();
                if (movedBack) {
                    await wait(180);

                    if (!isMarkResolvedEnabled() && getRemainingConflictCount() > 0) {
                        const retry = await clickVisibleConflictChoice(mode);
                        if (retry.clicked) {
                            clicks++;
                        }
                    }
                }

                await wait(250);
                if (isMarkResolvedEnabled()) {
                    setInternalRemaining(0);
                }
                if (getRemainingConflictCount() <= 1 && !isMarkResolvedEnabled()) {
                    // do not break yet if one is still left; continue loop
                } else {
                    break;
                }
            }

            const newCount = getRemainingConflictCount();
            updateDisplayedCountNow();

            if (newCount < lastCount) {
                lastCount = newCount;
                stuckRounds = 0;
            } else {
                stuckRounds++;
            }

            if (newCount <= 0 || isMarkResolvedEnabled()) {
                if (isMarkResolvedEnabled()) setInternalRemaining(0);
                break;
            }

            const moved = await clickNextConflict();
            if (moved) {
                await wait(LOOP_DELAY_MS);
            } else {
                // if next no longer moves, try previous once before declaring stuck
                const movedBack = await clickPrevConflict();
                if (movedBack) {
                    await wait(LOOP_DELAY_MS);
                } else {
                    await wait(120);
                }
            }

            if (stuckRounds >= 8) {
                // last recovery attempt: scan backward for skipped long conflict
                const recovered = await recoverSkippedLargeConflict(mode);
                if (!recovered.clicked) {
                    log('acceptAll stuck, breaking');
                    break;
                }
                clicks++;
                stuckRounds = 0;
            }
        }

        bulkActionRunning = false;
        bulkCancelRequested = false;
        updateDisplayedCountNow();

        if (isMarkResolvedEnabled()) {
            setInternalRemaining(0);
            setStatus('This file is ready.');
            setFileStatus('Mark as resolved is enabled.');
            queueRefresh();
            return;
        }

        if (getRemainingConflictCount() <= 0) {
            queueRefresh();
            return;
        }

        setStatus(`${mode === 'incoming' ? 'Accepted incoming' : 'Accepted current'} on ${clicks} conflict${clicks === 1 ? '' : 's'}.`);
        setFileStatus('Count starts from GitHub once, then updates locally.');
        queueRefresh();
        setTimeout(queueRefresh, 300);
        setTimeout(queueRefresh, 800);
        setTimeout(queueRefresh, 1500);
    }

    function disconnectObserver() {
        if (observer) {
            observer.disconnect();
            observer = null;
            observerRoot = null;
        }
    }

    function connectObserverIfNeeded() {
        if (!isConflictPage()) {
            disconnectObserver();
            return;
        }

        const root = document.querySelector('.js-conflict-resolver') || document.body;
        if (observer && observerRoot === root) return;

        disconnectObserver();

        observer = new MutationObserver(() => {
            queueRefresh();
            bindHotkeyToEditor();
        });

        observer.observe(root, {
            childList: true,
            subtree: true
        });

        observerRoot = root;
    }

    function queueRefresh() {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refreshUI, 120);
    }

    async function refreshUI() {
        if (!isConflictPage()) {
            stopAutoTimer();
            disconnectObserver();
            if (panel) panel.style.display = 'none';
            internalRemaining = null;
            lastSeenInitialCount = null;
            bulkActionRunning = false;
            bulkCancelRequested = false;
            autoMarkResolvedInProgress = false;
            autoCommitInProgress = false;
            autoContinueInProgress = false;
            lastAutoMarkResolvedKey = '';
            lastAutoCommitKey = '';
            lastAutoContinueKey = '';
            return;
        }

        injectStyles();
        ensurePanel();
        connectObserverIfNeeded();

        const currentSignature = getCurrentFileSignature();
        if (currentSignature !== lastFileSignature) {
            lastFileSignature = currentSignature;
            dismissedForCurrentFile = false;
            initializeInternalCountForCurrentFile(true);
            stopAutoTimer();
            bulkActionRunning = false;
            bulkCancelRequested = false;
            autoMarkResolvedInProgress = false;
        }

        const remaining = getRemainingConflictCount();
        const markResolvedEnabled = isMarkResolvedEnabled();
        const commitMergeBtn = getCommitMergeButton();

        if (markResolvedEnabled && internalRemaining !== 0) {
            setInternalRemaining(0);
        }

        updateDisplayedCountNow();

        if (dismissedForCurrentFile) {
            if (panel) panel.style.display = 'none';
            return;
        }

        if (commitMergeBtn && isVisible(commitMergeBtn)) {
            stopAutoTimer();
            if (panel) panel.style.display = 'none';
            await autoClickCommitMergeIfWanted();
            return;
        }

        if (markResolvedEnabled) {
            stopAutoTimer();
            if (panel) panel.style.display = 'none';
            await autoClickMarkResolvedIfWanted();
            return;
        }

        panel.style.display = '';

        if (remaining > 0) {
            setStatus('Choose how to resolve all conflicts in this file.');
            setFileStatus('Count starts from GitHub once, then updates locally.');
            if (!autoTimer && !bulkActionRunning) startAutoTimer();

            if (autoContinueEnabled && !bulkActionRunning && hasPickedMode) {
                await autoContinueSameChoiceIfWanted();
            }
            return;
        }

        stopAutoTimer();
        setStatus('No conflicts detected.');
        setFileStatus('Waiting for GitHub to update.');
    }

    async function handleHotkeys(event) {
        if (!isConflictPage()) return;

        if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
            const key = event.key.toLowerCase();

            if (key === 'n') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const ok = await clickNextConflict();
                if (ok) {
                    setStatus('Moved to next conflict.');
                    queueRefresh();
                    setTimeout(queueRefresh, 200);
                    setTimeout(queueRefresh, 700);
                } else {
                    setStatus('Next conflict button not found.');
                }
                return;
            }

            if (key === 'b') {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation();

                const ok = await clickPrevConflict();
                if (ok) {
                    setStatus('Moved to previous conflict.');
                    queueRefresh();
                    setTimeout(queueRefresh, 200);
                    setTimeout(queueRefresh, 700);
                } else {
                    setStatus('Previous conflict button not found.');
                }
            }
        }
    }

    function installHotkey() {
        window.addEventListener('keydown', handleHotkeys, true);
        document.addEventListener('keydown', handleHotkeys, true);
        bindHotkeyToEditor();
    }

    function bindHotkeyToEditor() {
        const editor = getEditorElement();
        if (!editor || editor.dataset.krxHotkeysBound === '1') return;

        editor.dataset.krxHotkeysBound = '1';
        editor.addEventListener('keydown', handleHotkeys, true);
    }

    function installUrlWatcher() {
        if (urlWatcher) clearInterval(urlWatcher);

        urlWatcher = setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                lastFileSignature = '';
                dismissedForCurrentFile = false;
                internalRemaining = null;
                lastSeenInitialCount = null;
                bulkActionRunning = false;
                bulkCancelRequested = false;
                autoMarkResolvedInProgress = false;
                autoCommitInProgress = false;
                autoContinueInProgress = false;
                lastAutoMarkResolvedKey = '';
                lastAutoCommitKey = '';
                lastAutoContinueKey = '';
                disconnectObserver();
                queueRefresh();
                setTimeout(queueRefresh, 300);
                setTimeout(queueRefresh, 900);
                setTimeout(queueRefresh, 1800);
            }
        }, 1000);
    }

    function installClickHooks() {
        document.addEventListener('click', (event) => {
            const btn = event.target && event.target.closest ? event.target.closest('button') : null;
            if (!btn) return;

            const txt = normalizeText(btn.textContent);
            const label = normalizeText(btn.getAttribute('aria-label') || '');

            if (
                txt === 'accept current change' ||
                txt === 'accept incoming change' ||
                txt === 'accept both changes'
            ) {
                if (txt === 'accept current change') rememberPickedMode('current');
                if (txt === 'accept incoming change') rememberPickedMode('incoming');

                const widget = btn.closest('.CodeMirror-linewidget');
                if (widget) {
                    monitorWidgetResolution(widget);
                }

                setTimeout(queueRefresh, 100);
                setTimeout(queueRefresh, 300);
                setTimeout(queueRefresh, 700);
                return;
            }

            if (
                txt === 'mark as resolved' ||
                txt === 'commit merge' ||
                label === 'next conflict' ||
                label === 'previous conflict' ||
                btn.classList.contains('js-next-conflict') ||
                btn.classList.contains('js-prev-conflict') ||
                btn.classList.contains('js-mark-resolved')
            ) {
                if (txt === 'mark as resolved' && isMarkResolvedEnabled()) {
                    setInternalRemaining(0);
                }
                setTimeout(queueRefresh, 100);
                setTimeout(queueRefresh, 350);
                setTimeout(queueRefresh, 900);
            }
        }, true);
    }

    function init() {
        installHotkey();
        installUrlWatcher();
        installClickHooks();

        queueRefresh();
        setTimeout(queueRefresh, 400);
        setTimeout(queueRefresh, 1200);
        setTimeout(queueRefresh, 2500);
    }

    init();
})();