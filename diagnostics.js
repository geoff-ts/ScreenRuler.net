(function () {
    var notes = [];
    var panel = null;

    function paint() {
        if (!document.body) { setTimeout(paint, 50); return; }
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'screenRulerDiagnostics';
            // Inline styles only: the utility classes come from a CDN that
            // may itself be the thing that failed.
            panel.style.cssText = 'position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;' +
                'overflow:auto;padding:16px;margin:0;background:#0a0a0a;color:#e5e5e5;' +
                'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;' +
                'word-break:break-word;-webkit-user-select:text;user-select:text;';
            document.body.appendChild(panel);
        }
        panel.textContent = 'Screen Ruler could not start in this browser.\n\n' + notes.join('\n\n');
    }

    // Recording is always safe; painting is not. A single missing resource must
    // never cover a ruler that is drawing perfectly well, so only an uncaught
    // exception paints on sight. Everything else is held until the watchdog
    // confirms the app really did fail to start.
    function note(text, showNow) {
        if (notes.indexOf(text) === -1) notes.push(text);
        if (showNow || panel) paint();
    }

    // Capture phase, because resource load failures do not bubble.
    window.addEventListener('error', function (event) {
        var target = event.target;
        if (target && target !== window && (target.src || target.href)) {
            note('Failed to load resource:\n  ' + (target.src || target.href), false);
            return;
        }
        note('Uncaught ' + (event.message || 'error') +
             '\n  at ' + (event.filename || 'unknown') + ':' + event.lineno + ':' + event.colno, true);
    }, true);

    window.addEventListener('unhandledrejection', function (event) {
        var reason = event.reason;
        note('Unhandled promise rejection:\n  ' + ((reason && (reason.stack || reason.message)) || String(reason)), true);
    });

    function probe(label, fn) {
        try { return label + '=' + fn(); } catch (error) { return label + '=THREW ' + error; }
    }

    // If the canvas is still at its intrinsic 300x150 the app never booted,
    // whether or not anything threw. Report the environment either way.
    setTimeout(function () {
        var canvas = document.getElementById('rulerCanvas');
        if (canvas && canvas.width > 300) return;
        note('The ruler canvas was never sized, so startup did not complete.\n\n' + [
            probe('readyState', function () { return document.readyState; }),
            probe('canvas', function () { return canvas ? canvas.width + 'x' + canvas.height : 'MISSING'; }),
            probe('tailwind', function () { return typeof window.tailwind; }),
            probe('devicePresets', function () { return window.SCREEN_RULER_DEVICE_DATA ? window.SCREEN_RULER_DEVICE_DATA.presets.length + ' presets' : 'MISSING'; }),
            probe('rulerConfig', function () { return window.SCREEN_RULER_CONFIG ? 'loaded' : 'MISSING'; }),
            probe('safeStorage', function () { return typeof safeStorage; }),
            probe('drawAll', function () { return typeof drawAll; }),
            probe('bootRan', function () { return typeof hasBooted !== 'undefined' ? hasBooted : 'undefined'; }),
            probe('localStorage', function () { window.localStorage.getItem('x'); return 'readable'; }),
            probe('viewport', function () { return window.innerWidth + 'x' + window.innerHeight; }),
            probe('screen', function () { return screen.width + 'x' + screen.height + ' dpr' + window.devicePixelRatio; }),
            probe('framed', function () { return window.top !== window.self; }),
            probe('origin', function () { return String(window.origin); }),
            probe('ua', function () { return navigator.userAgent; }),
        ].join('\n'), true);
    }, 6000);
})();
