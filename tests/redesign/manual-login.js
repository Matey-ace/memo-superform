'use strict';

// Isolated, headed browser for the user's own Maimemo login.
// Never log credentials, page contents, storage, or callback query strings.
const path = require('path');
const { chromium } = require('playwright');

(async () => {
    const base = process.argv[2] || 'http://127.0.0.1:55395';
    const context = await chromium.launchPersistentContext(
        path.resolve('_verification/redesign/manual-login-profile'),
        {
            executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
            headless: false,
            viewport: { width: 1440, height: 900 },
            args: ['--remote-debugging-port=9337', '--remote-debugging-address=127.0.0.1']
        }
    );
    const page = context.pages()[0] || await context.newPage();
    await page.goto(base, { waitUntil: 'load', timeout: 30000 });
    if (await page.locator('#welcomeSettingsBtn').isVisible()) {
        await page.click('#welcomeSettingsBtn');
        await page.click('#closeSettings');
    }
    const selector = page.locator('.tile[data-tile="0"] .chart-selector');
    await selector.waitFor({ state: 'visible' });
    await selector.selectOption('study-web');
    await page.locator('.study-web-iframe').first().waitFor({ state: 'attached' });
    console.log('MANUAL_LOGIN_READY: isolated Edge window; enter credentials yourself.');
    console.log('No credentials or authentication state will be printed.');
    await context.waitForEvent('close', { timeout: 0 });
})().catch((error) => {
    // Do not print URLs that could contain a callback token.
    console.error('Manual-login setup failed:', error.name);
    process.exitCode = 1;
});
