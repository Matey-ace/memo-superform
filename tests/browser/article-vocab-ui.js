/* eslint-disable */
/**
 * 文章选词的真实浏览器验收（Playwright + Edge）。
 *
 * 与 `tests/article-vocab-regression.js` 的分工：那个用 fake DOM 验证**逻辑契约**，
 * 这个在真实渲染引擎里验证**可达性与两套主题下的可读性**——
 * 按钮真的能点到、浮层真的能打开、Escape 真的能关、窄屏真的不溢出。
 *
 * 后端一律用 `page.route` 拦截：不连真实云端、不读真实凭据、不写任何账号。
 *
 * 用法：node tests/browser/article-vocab-ui.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '../..');
const output = path.join(root, '_verification', 'perfvocab', 'G');
fs.mkdirSync(output, { recursive: true });

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/**
 * 最小静态服务。
 *
 * 不能把页面写进 about:blank 再引用 `file://` 脚本：Chromium 会拒绝
 * "Not allowed to load local resource"，模块根本加载不上，测试就变成假失败。
 * 因此这里起一个只读静态服务，让 `js/*.js` 与 `css/*.css` 走同源相对路径。
 */
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.gif': 'image/gif'
};

function startStaticServer() {
    const server = http.createServer(function (req, res) {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '/fixture.html') {
            res.writeHead(200, { 'Content-Type': MIME['.html'] });
            res.end(server.fixtureHtml || '<!doctype html><title>empty</title>');
            return;
        }
        const target = path.join(root, urlPath.replace(/^\/+/, ''));
        // 只允许仓库内文件，避免路径穿越。
        if (!target.startsWith(root) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('not found');
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream'
        });
        fs.createReadStream(target).pipe(res);
    });
    return new Promise(function (resolve) {
        server.listen(0, '127.0.0.1', function () {
            resolve({ server: server, base: 'http://127.0.0.1:' + server.address().port });
        });
    });
}

let passed = 0;
const failures = [];

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

const FAKE_ITEMS = {
    items: [
        {
            lemma: 'resilient', surface: 'resilient', pos: 'adj.',
            gloss_zh: '有韧性的', context: 'The resilient wetland recovered.',
            reason: '学术与日常都常用', rank: 1
        },
        {
            lemma: 'restore', surface: 'restored', pos: 'v.',
            gloss_zh: '恢复', context: 'voted to restore the wetland',
            reason: '高频动词', rank: 2
        }
    ],
    rejected: [{ lemma: 'fabricated', reason: 'context_not_in_source' }],
    truncated: false
};

function fixture(style) {
    // 页面由本地静态服务提供，因此这里用同源绝对路径 `/js/...`。
    return `<!doctype html>
<html data-ui-style="${style}">
<head>
<meta charset="utf-8">
<title>article vocab fixture</title>
<link rel="stylesheet" href="/css/article-vocab.css">
<style>
  body { margin:0; padding:16px; font-family: system-ui, sans-serif; color:#1a1a2e; background:#fff; }
  html[data-ui-style="notebook"] body { background:#fbf7ec; }
</style>
</head>
<body>
<button id="articleVocabBtn" type="button" class="article-vocab-btn">从文章选词</button>
<script src="/js/article-vocab.js"></script>
<script src="/js/article-vocab-wire.js"></script>
<script>
  window.__errors = [];
  window.addEventListener('error', function (e) { window.__errors.push(String(e.message)); });
  // 假 Key 只用于让“已配置 AI”这个前置条件成立；真正的网络请求全部被
  // page.route 拦截，不会离开本机，也不会发到任何真实服务。
  localStorage.setItem('ai_key', 'test-key-not-real');
  localStorage.setItem('ai_endpoint', 'https://api.example.invalid/v1');
  ArticleVocabUI.init();
  window.__ready = true;
</script>
</body>
</html>`;
}

/**
 * 拦截全部后端。
 *
 * 用正则而不是 glob：glob 在本机 `127.0.0.1:port` 下曾出现命中不到、
 * 请求落到静态服务返回 404 的情况，导致假失败。正则锚定路径更确定。
 */
async function stubBackend(page, options) {
    const opts = options || {};
    // 记录发出的 AI 请求体。存在 Node 侧的 page 对象上，不依赖页面里的全局，
    // 断言时直接读这个数组（早期版本误读 window.__aiBodies，永远为空）。
    const aiBodies = [];
    const addBodies = [];
    page.aiBodies = aiBodies;
    page.addBodies = addBodies;
    await page.route(/\/api\/article-vocab\/select$/, async function (route) {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                messages: [
                    { role: 'system', content: 'return JSON' },
                    { role: 'user', content: 'pick words' }
                ],
                chars: 120,
                truncated: false
            })
        });
    });
    await page.route(/\/proxy\/ai$/, async function (route) {
        const posted = JSON.parse(route.request().postData() || '{}');
        aiBodies.push(posted);
        if (opts.aiFails) {
            await route.fulfill({
                status: 502,
                contentType: 'application/json',
                body: JSON.stringify({ error: '上游不可用' })
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                choices: [{ message: { content: JSON.stringify(FAKE_ITEMS) } }]
            })
        });
    });
    await page.route(/\/api\/article-vocab\/parse$/, async function (route) {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify(FAKE_ITEMS)
        });
    });
    await page.route(/\/api\/article-vocab\/query-ids$/, async function (route) {
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                matched: {}, missing: ['resilient', 'restore'],
                ambiguous: {}, requested: 2
            })
        });
    });
    await page.route(/\/api\/article-vocab\/add$/, async function (route) {
        // 记录真实发出的请求体：只在 fulfill 里返回假响应，就等于只测了
        // "UI 拿到 200 后怎么渲染"，完全测不到"请求体字段对不对"。
        // 真实缺陷就是这样漏掉的：wire 读 payload.operationId / payload.lemmas，
        // 而模块发的是 operation_id / items[]，于是 body 恒为
        // {operationId: undefined, lemmas: []}，后端只会回 400。
        const posted = JSON.parse(route.request().postData() || '{}');
        addBodies.push(posted);
        // 如实返回"一个都没加"：未查到官方 ID 时上游本就不会提交。
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                submitted: 0, added_count: 0, shortfall: 0, status: 'none',
                note: '所选词未在墨墨词库中查到，未提交'
            })
        });
    });
}

/** `/add` 请求体的契约：这三个字段错一个，真实环境里就永远写不进云端。 */
function assertAddBody(body) {
    if (!body || typeof body !== 'object') throw new Error('没有捕获到 /add 请求体');
    const operationId = body.operationId;
    if (typeof operationId !== 'string' || operationId.trim() === '') {
        throw new Error('operationId 为空（后端会 400 缺少 operationId）：' + JSON.stringify(body));
    }
    if (!Array.isArray(body.lemmas) || body.lemmas.length === 0) {
        throw new Error('lemmas 为空数组（后端会 400 empty）：' + JSON.stringify(body));
    }
    if (!body.lemmas.every(function (value) { return typeof value === 'string' && value !== ''; })) {
        throw new Error('lemmas 含空值：' + JSON.stringify(body.lemmas));
    }
    if (body.confirm !== true) throw new Error('confirm 必须为 true：' + JSON.stringify(body));
    if (body.advance !== false) throw new Error('advance 必须为 false：' + JSON.stringify(body));
}

async function main() {
    const started = await startStaticServer();
    const staticServer = started.server;
    const base = started.base;

    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });

    async function openFixture(style) {
        staticServer.fixtureHtml = fixture(style);
        const page = await context.newPage();
        await page.goto(base + '/fixture.html', { waitUntil: 'load' });
        return page;
    }

    for (const style of ['standard', 'notebook']) {
        const page = await openFixture(style);
        const consoleErrors = [];
        page.on('pageerror', function (error) { consoleErrors.push(String(error)); });

        await stubBackend(page);
        await page.waitForFunction('window.__ready === true');

        await checkAsync(`[${style}] 入口按钮可见且可点击`, async function () {
            const button = page.locator('#articleVocabBtn');
            if (!(await button.isVisible())) throw new Error('入口按钮不可见');
            if (!(await button.isEnabled())) throw new Error('入口按钮不可点击');
        });

        await checkAsync(`[${style}] 默认不创建浮层（不打开就不干活）`, async function () {
            const count = await page.locator('.article-vocab-overlay').count();
            if (count !== 0) throw new Error('未点击就创建了浮层，共 ' + count + ' 个');
        });

        await checkAsync(`[${style}] 点击后浮层打开且面板可见`, async function () {
            await page.click('#articleVocabBtn');
            await page.waitForSelector('.article-vocab-overlay:not([hidden])', { timeout: 4000 });
            const panel = page.locator('.article-vocab-overlay__panel');
            if (!(await panel.isVisible())) throw new Error('面板不可见');
            const box = await panel.boundingBox();
            if (!box || box.width < 200) throw new Error('面板尺寸异常：' + JSON.stringify(box));
        });

        await checkAsync(`[${style}] 面板内有文章输入框与选词按钮`, async function () {
            const textarea = page.locator('[data-testid="article-vocab-text"]');
            // The form mounts after the account-status request, not when its shell opens.
            await textarea.waitFor({ state: 'visible', timeout: 4000 });
            if (!(await textarea.isVisible())) throw new Error('缺少文章输入框');
            const selectBtn = page.locator('[data-testid="article-vocab-select"]');
            if (!(await selectBtn.isVisible())) throw new Error('缺少选词按钮');
        });

        await checkAsync(`[${style}] 窄屏（420px）不横向溢出`, async function () {
            await page.setViewportSize({ width: 420, height: 800 });
            const overflow = await page.evaluate(function () {
                const panel = document.querySelector('.article-vocab-overlay__panel');
                if (!panel) return { error: 'no panel' };
                return {
                    docScroll: document.documentElement.scrollWidth,
                    docClient: document.documentElement.clientWidth,
                    panelScroll: panel.scrollWidth,
                    panelClient: panel.clientWidth
                };
            });
            if (overflow.docScroll > overflow.docClient + 2) {
                throw new Error('页面横向溢出：' + JSON.stringify(overflow));
            }
            if (overflow.panelScroll > overflow.panelClient + 2) {
                throw new Error('面板横向溢出：' + JSON.stringify(overflow));
            }
            await page.setViewportSize({ width: 1280, height: 860 });
        });

        await checkAsync(`[${style}] Escape 关闭浮层`, async function () {
            await page.keyboard.press('Escape');
            // 关闭是"加上 hidden 属性"，元素本身按定义不可见，
            // 所以必须用 state:'attached' 而不是默认的可见性等待。
            await page.waitForSelector('.article-vocab-overlay[hidden]',
                { state: 'attached', timeout: 3000 });
        });

        await checkAsync(`[${style}] 无未捕获页面错误`, async function () {
            if (consoleErrors.length) throw new Error('pageerror: ' + consoleErrors.join(' | '));
            const inner = await page.evaluate('window.__errors || []');
            if (inner.length) throw new Error('window error: ' + inner.join(' | '));
        });

        await page.close();
    }

    // 端到端一次：粘贴文章 → 选词 → 看到候选（含被拒绝条目说明）
    const page = await context.newPage();
    staticServer.fixtureHtml = fixture('standard');
    await page.goto(base + '/fixture.html', { waitUntil: 'load' });
    await stubBackend(page);
    await page.waitForFunction('window.__ready === true');
    await page.click('#articleVocabBtn');
    await page.waitForSelector('.article-vocab-overlay:not([hidden])');

    await page.locator('[data-testid="article-vocab-text"]').click();
    // 用真实键盘输入而不是 fill()：模块监听 input 事件更新 state，
    // 这里顺便验证真实交互路径能把文本送进状态机。
    await page.keyboard.type(
        'The city council voted to restore the wetland. The resilient wetland recovered.',
        { delay: 2 });
    await page.click('[data-testid="article-vocab-select"]');

    await checkAsync('选词后端到端：显示候选项', async function () {
        // 直接等候选条目出现在 DOM 里。
        // 不要只等"阶段文案变了"：中间态"正在挑选…"同样是一个非初始文案，
        // 会在候选渲染之前就满足条件，导致读到时还是空列表（早期版本就栽在这）。
        await page.waitForFunction(function () {
            const body = document.querySelector('.article-vocab-overlay__body');
            return !!body && /resilient/.test(body.innerText || '');
        }, { timeout: 15000 });
        const body = await page.locator('.article-vocab-overlay__body').innerText();
        if (!/resilient/.test(body)) throw new Error('未显示候选 resilient：' + body.slice(0, 300));
    });

    await checkAsync('AI 请求带 noMemory=true（隔离角色记忆）', async function () {
        const bodies = page.aiBodies || [];
        if (!bodies.length) throw new Error('没有发出 AI 请求');
        for (const item of bodies) {
            if (item.noMemory !== true) {
                throw new Error('AI 请求缺少 noMemory: ' + JSON.stringify(item).slice(0, 200));
            }
        }
    });

    await checkAsync('候选区不出现“已添加/成功”这类编造状态', async function () {
        const body = await page.locator('.article-vocab-overlay__body').innerText();
        if (/已添加|添加成功|已成功加入/.test(body)) {
            throw new Error('出现未发生写入却宣称成功的文案：' + body.slice(0, 200));
        }
    });

    await checkAsync('真实点击“加入”后 /add 请求体字段完整', async function () {
        // 这一步是真正能拦住 wire 字段名错位的地方：必须真的触发一次提交，
        // 然后检查发出去的 body。只 fulfill 假响应而不看 body 是测不到这个的。
        const submit = page.locator('[data-testid="article-vocab-submit"]');
        if (!(await submit.isVisible())) throw new Error('找不到“加入墨墨学习列表”按钮');
        await submit.click();
        // 等请求真正到达 route 层。
        const deadline = Date.now() + 8000;
        while ((page.addBodies || []).length === 0 && Date.now() < deadline) {
            await page.waitForTimeout(100);
        }
        const bodies = page.addBodies || [];
        if (!bodies.length) throw new Error('点击后没有发出 /add 请求');
        assertAddBody(bodies[bodies.length - 1]);
    });

    await checkAsync('自动添加默认关闭', async function () {
        const checked = await page.evaluate(function () {
            const toggle = document.querySelector('[data-testid="article-vocab-auto-add"]');
            return toggle ? toggle.checked : null;
        });
        if (checked === true) throw new Error('自动添加默认就是开启的');
    });

    await page.screenshot({
        path: path.join(output, 'article-vocab-preview.png'), fullPage: false
    });
    await page.close();
    await context.close();
    await browser.close();
    await new Promise(function (resolve) { staticServer.close(resolve); });

    if (failures.length) {
        console.log('\n' + failures.length + ' 项失败：');
        for (const item of failures) console.log('  - ' + item.name + ' :: ' + item.message);
        console.log('ARTICLE_VOCAB_UI_FAIL');
        process.exit(1);
    }
    console.log('\n通过 ' + passed + ' 项，失败 0 项');
    console.log('ARTICLE_VOCAB_UI_PASS');
}

main().catch(function (error) {
    console.error(error);
    process.exit(1);
});