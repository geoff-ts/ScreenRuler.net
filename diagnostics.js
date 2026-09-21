(function () {
    const started = Date.now();
    const root = document.documentElement;
    const notes = [];
    window.SCREEN_RULER_TRACE = function (label) {
        root.setAttribute('data-ruler-boot', ((root.getAttribute('data-ruler-boot') || '') + ' ' + label + '@' + (Date.now() - started)).trim());
    };
    window.SCREEN_RULER_TRACE('script');
    function note(message) {
        notes.push(String(message));
        root.setAttribute('data-ruler-notes', notes.join(' | ').slice(-2000));
    }
    function showFallback() {
        root.removeAttribute('data-ruler-ready');
        root.setAttribute('data-ruler-failed', 'true');
        const message = document.getElementById('startupMessage');
        if (message) {
            message.hidden = false;
            message.textContent = 'The interactive ruler could not load. Reload to retry, or use the guides above for calibration and measuring help.';
        }
        document.body?.classList.remove('ad-visible');
        document.getElementById('bottomAdContainer')?.classList.add('hidden');
    }
    window.addEventListener('error', function (event) {
        const target = event.target;
        if (target && target !== window && (target.src || target.href)) {
            note('Resource unavailable: ' + (target.src || target.href));
            return;
        }
        note((event.message || 'Script error') + ' at ' + (event.filename || 'unknown'));
        // Optional advertising failures must not cover a working measuring tool.
        try {
            const source = new URL(event.filename);
            if (source.origin === new URL(document.baseURI).origin && source.pathname === '/app.js') showFallback();
        } catch (_) { /* Opaque third-party errors have no source URL. */ }
    }, true);
    window.addEventListener('unhandledrejection', function (event) {
        note('Promise rejected: ' + (event.reason?.message || String(event.reason)));
    });
    setTimeout(function () {
        if (!root.hasAttribute('data-ruler-ready')) {
            note('Startup has not completed');
            showFallback();
        }
    }, 10000);
})();
