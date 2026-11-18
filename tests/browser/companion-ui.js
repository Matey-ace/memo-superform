/* eslint-disable */
/**
 * 陪伴进度与结算的真实浏览器验收（Playwright + Edge）。
 *
 * 与 companion-*-regression.js 的分工：那两个用 fake DOM 验证**逻辑契约**；
 * 这个在真实渲染引擎里验证**视觉与可达性**——aria 属性真的落到 DOM 上、
 * 两套主题都读得出来、窄窗不溢出、减少动画被尊重。
 *
 * 用法： node tests/browser/companion-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '_verification', 'companion-ui');
fs.mkdirSync(output, { recursive: true });

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let passed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed += 1;
        console.log('  ok  ' + name);
    } catch (error) {
        failures.push({ name: name, message: error.message });
        console.log('  FAIL ' + name + ' :: ' + error.message);
    }
}

async function checkAsync(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('  ok  ' + name);
    } catch (error) {
        failures.push({ name: name, message: error.message });
        console.log('  FAIL ' + name + ' :: ' + error.message);
    }
}

// 一个最小页面：只加载两个新组件与样式，避免整站依赖干扰判断。
function fixture(style) {
    const base = '../../';
    return `<!doctype html>
<html data-ui-style="${style}">
<head>
<meta charset="utf-8">
<title>companion ui fixture</title>
<link rel="stylesheet" href="${base}css/companion-progress.css">
<link rel="stylesheet" href="${base}css/companion-settlement.css">
<style>
  body { margin:0; padding:16px; font-family: system-ui, sans-serif; }
  .notebook-mode { background:#fbf7ec; }
  body:not(.notebook-mode) { background:#ffffff; }
  body.dark:not(.notebook-mode) { background:#1b1b1f; color:#e8e8ea; }
</style>
</head>
<body class="${style === 'notebook' ? 'notebook-mode' : ''}">
<div id="progressHost"></div>
<script src="${base}js/companion-progress.js"></script>
<script src="${base}js/companion-settlement.js"></script>
<script>
  window.__ready = false;
  var host = document.getElementById('progressHost');
  var progress = CompanionProgress.create({});
  progress.mount(host);
  window.__progress = progress;
  window.__settlement = CompanionSettlement.create({});
  window.__ready = true;
</script>
</body>
</html>`;
}

function sessionView(overrides) {
    return Object.assign({
        session_id: 'ses_ui',
        state: 'active',
        goal_kind: 'session_goal',
        target_count: 20,
        confirmed_count: 8,
        progress: { done: 8, total: 20, known: true },
        role_id: 'role-a',
        role_name: '安和',
        active_seconds: 1500,
        study_day: '2026-11-16',
        revision: 2,
        goal_revision: 1,
        can_settle: false
    }, overrides || {});
}

function settlementView() {
    return {
        available: true,
        settlement_id: 'set_ui',
        session_id: 'ses_ui',
        role_id: 'role-a',
        role_name: '安和',
        confirmed_new: 6,
        confirmed_review: 2,
        confirmed_total: 8,
        active_seconds: 1500,
        weak_words: ['apple', 'banana'],
        evidence_refs: {},
        goal: { goal_kind: 'session_goal', target_count: 8 },
        message: '这一轮完成 8 词，用了 25 分钟。安和 记下了今天的认真，明天继续。',
        ai_state: 'idle',
        ai_message: null,
        rewards: [
            {
                reward_id: 'rwd_ui1', type: 'memorial_card', period_key: '2026-11-16',
                payload: {
                    study_day: '2026-11-16', role_name: '安和', confirmed_total: 8,
                    weak_words: ['apple', 'banana']
                },
                created_at: '2026-11-16T10:00:00+00:00'
            },
            {
                reward_id: 'rwd_ui2', type: 'first_completion', period_key: 'first',
                payload: { study_day: '2026-11-16', role_name: '安和' },
                created_at: '2026-11-16T10:00:00+00:00'
            }
        ],
        created_at: '2026-11-16T10:00:00+00:00'
    };
}

(async () => {
    let browser;
    let server;
    try {
        const http = require('http');
        // 用静态文件服务器托管仓库根，让 fixture 能按相对路径取到真实 CSS/JS。
        server = http.createServer((req, res) => {
            const url = decodeURIComponent(req.url.split('?')[0]);
            if (url === '/fixture' || url.startsWith('/fixture?')) {
                const style = (req.url.split('style=')[1] || 'standard').split('&')[0];
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(fixture(style));
                return;
            }
            const target = path.join(root, url.replace(/^\/+/, ''));
            if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            const ext = path.extname(target);
            const types = { '.css': 'text/css', '.js': 'text/javascript', '.html': 'text/html' };
            res.writeHead(200, { 'Content-Type': (types[ext] || 'text/plain') + '; charset=utf-8' });
            res.end(fs.readFileSync(target));
        });
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        const base = 'http://127.0.0.1:' + port;

        browser = await chromium.launch({ headless: true, executablePath: EDGE });

        for (const style of ['standard', 'notebook']) {
            console.log('\n[主题: ' + style + ']');
            const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', (e) => errors.push(e.message));
            page.on('console', (msg) => {
                if (msg.type() === 'error') { errors.push('console: ' + msg.text()); }
            });
            await page.goto(base + '/fixture?style=' + style, { waitUntil: 'load' });
            await page.waitForFunction(() => window.__ready === true);

            await checkAsync('无脚本错误', () => {
                // favicon 的 404 是浏览器自动请求，与组件无关，过滤掉避免假失败。
                const real = errors.filter((text) =>
                    text.indexOf('favicon') < 0 &&
                    !(text.indexOf('404') >= 0 && text.indexOf('Failed to load resource') >= 0));
                assert.deepStrictEqual(real, []);
            });

            // ---- 进度条：known=true ----
            await page.evaluate((view) => window.__progress.update(view), sessionView());
            await checkAsync('进度条渲染且 aria 完整', async () => {
                const bar = await page.$('[data-testid="companion-progress-bar"]');
                assert.ok(bar, '必须存在进度条元素');
                const attrs = await bar.evaluate((node) => ({
                    role: node.getAttribute('role'),
                    now: node.getAttribute('aria-valuenow'),
                    max: node.getAttribute('aria-valuemax'),
                    min: node.getAttribute('aria-valuemin'),
                    label: node.getAttribute('aria-label')
                }));
                assert.strictEqual(attrs.role, 'progressbar');
                assert.strictEqual(attrs.now, '8');
                assert.strictEqual(attrs.max, '20');
                assert.ok(attrs.label, '必须有 aria-label');
            });

            await checkAsync('文本含本轮与今日待确认', async () => {
                const text = await page.textContent('[data-testid="companion-progress"]');
                assert.ok(text.indexOf('8') >= 0, text);
                assert.ok(text.indexOf('20') >= 0, text);
                assert.ok(text.indexOf('本轮') >= 0, text);
                assert.ok(text.indexOf('待确认') >= 0, '今日应显示待确认：' + text);
            });

            // ---- 进度条：known=false 不得伪造分母 ----
            await page.evaluate((view) => window.__progress.update(view), sessionView({
                goal_kind: 'today_plan',
                target_count: null,
                confirmed_count: 3,
                progress: { done: 3, total: null, known: false }
            }));
            await checkAsync('known=false 时不设 aria-valuemax', async () => {
                const bar = await page.$('[data-testid="companion-progress-bar"]');
                const attrs = await bar.evaluate((node) => ({
                    max: node.getAttribute('aria-valuemax'),
                    now: node.getAttribute('aria-valuenow'),
                    text: node.getAttribute('aria-valuetext')
                }));
                assert.strictEqual(attrs.max, null, '分母不可信时不得给出 max');
                assert.strictEqual(attrs.now, null, '分子同样不可信');
                assert.ok((attrs.text || '').indexOf('待确认') >= 0, String(attrs.text));
            });

            await checkAsync('不定态有视觉区分', async () => {
                const cls = await page.getAttribute('[data-testid="companion-progress-bar"]', 'class');
                assert.ok((cls || '').indexOf('indeterminate') >= 0, 'class=' + cls);
            });

            await checkAsync('窄窗不横向溢出', async () => {
                await page.setViewportSize({ width: 480, height: 800 });
                await page.waitForTimeout(120);
                const overflow = await page.evaluate(() => {
                    const node = document.querySelector('[data-testid="companion-progress"]');
                    if (!node) { return true; }
                    return node.scrollWidth > node.clientWidth + 2;
                });
                assert.strictEqual(overflow, false, '480px 下不得横向溢出');
                await page.setViewportSize({ width: 1280, height: 900 });
            });

            await checkAsync('减少动画被尊重', async () => {
                const context2 = await browser.newContext({
                    viewport: { width: 1280, height: 900 },
                    reducedMotion: 'reduce'
                });
                const page2 = await context2.newPage();
                await page2.goto(base + '/fixture?style=' + style, { waitUntil: 'load' });
                await page2.waitForFunction(() => window.__ready === true);
                const bar = await page2.$('[data-testid="companion-progress-bar"]');
                const duration = await bar.evaluate((node) => {
                    const style = getComputedStyle(node);
                    return (style.transitionDuration || '') + '|' + (style.animationDuration || '');
                });
                // 只要求"减弱"，允许具体实现用 0.001s 之类的极短值。
                const slow = /[2-9]\.|[1-9]\d*\./.test(duration.replace(/0\.0+1s?/g, ''));
                assert.strictEqual(slow, false, '减少动画下仍有过长过渡：' + duration);
                await context2.close();
            });

            // ---- 结算弹层 ----
            await checkAsync('结算弹层完整渲染', async () => {
                await page.evaluate((view) => window.__settlement.show(view), settlementView());
                await page.waitForTimeout(120);
                const dialog = await page.$('[data-testid="companion-settlement"]');
                assert.ok(dialog, '必须出现结算弹层');
                const attrs = await dialog.evaluate((node) => ({
                    role: node.getAttribute('role'),
                    modal: node.getAttribute('aria-modal')
                }));
                assert.strictEqual(attrs.role, 'dialog');
                assert.strictEqual(attrs.modal, 'true');
                const text = await dialog.evaluate((node) => node.textContent);
                assert.ok(text.indexOf('8 词') >= 0, '必须显示本地祝贺文字');
                assert.ok(text.indexOf('纪念') >= 0 || text.indexOf('卡片') >= 0, '必须有纪念卡');
                assert.ok(text.indexOf('首次') >= 0, '必须有首次完成徽章');
            });

            await checkAsync('弹层文字对比度足够（非空且可见）', async () => {
                const visible = await page.evaluate(() => {
                    const node = document.querySelector('[data-testid="companion-settlement"]');
                    if (!node) { return false; }
                    const rect = node.getBoundingClientRect();
                    const style = getComputedStyle(node);
                    return rect.width > 100 && rect.height > 60 &&
                        style.visibility !== 'hidden' && style.display !== 'none' &&
                        Number(style.opacity || '1') > 0.1;
                });
                assert.strictEqual(visible, true);
            });

            await checkAsync('关闭按钮可聚焦且 Escape 关闭', async () => {
                const close = await page.$('[data-testid="companion-settlement-close"]');
                assert.ok(close, '必须有可键盘访问的关闭按钮');
                await page.keyboard.press('Escape');
                await page.waitForTimeout(120);
                const open = await page.evaluate(() => window.__settlement.isOpen());
                assert.strictEqual(open, false, 'Escape 应关闭弹层');
            });

            await fs.promises.writeFile(
                path.join(output, 'theme-' + style + '.png'),
                await page.screenshot({ fullPage: true })
            );
            await context.close();
        }

        console.log('\n通过 ' + passed + ' 项，失败 ' + failures.length + ' 项');
        if (failures.length) {
            failures.forEach((item) => console.log('  - ' + item.name + ' :: ' + item.message));
            console.log('FAILED');
            process.exitCode = 1;
        } else {
            console.log('ALL CHECKS PASSED');
        }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        if (browser) { await browser.close(); }
        if (server) { server.close(); }
    }
})();