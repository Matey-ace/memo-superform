/* eslint-disable */
/**
 * 墨墨学习界面截图 + 行为一致性探针。
 *
 * 关键约束（第 10 节）：不得为了"能截图"而修改页面结构、隐藏元素或改变点击区域。
 * 因此本工具只做两件事：截图，以及记录会随样式改动而变化的**计算样式**。
 *
 * 学习界面在**同源 iframe** 里（`/memo-tc/webstudy/app`），可以跨 frame 访问。
 *
 * 用法：
 *   node tests/redesign/capture_study.js --base <url> --out <dir> [--theme standard|notebook]
 *
 * 注意：未登录墨墨时 iframe 会停在登录页。工具会截图登录页并如实标注
 * `stage=login`，**不会**假装进入了学习流程。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i += 2) {
        out[argv[i].replace(/^--/, '')] = argv[i + 1];
    }
    return out;
}

async function frameReport(frame) {
    if (!frame) return null;
    return frame.evaluate(function () {
        const html = document.documentElement;
        const findings = {
            htmlClasses: html.className,
            hasMemoStandard: html.classList.contains('memo-standard'),
            hasMemoNotebook: html.classList.contains('memo-notebook'),
            hasMemoDark: html.classList.contains('memo-dark'),
            injectedLinks: Array.prototype.slice
                .call(document.querySelectorAll('link[rel=stylesheet]'))
                .map(function (l) {
                    return { id: l.id, href: (l.getAttribute('href') || '').split('?')[0] };
                })
                .filter(function (l) {
                    // 只关心我们注入的皮肤，SPA 自带的几十个 link 不看
                    return /memo/i.test(l.id || '') || /maimemo-/.test(l.href || '');
                }),
            doesNotHaveMainInject: !document.getElementById('memo-theme-main-inject'),
            bodyBg: getComputedStyle(document.body).backgroundColor,
            // 学习界面的关键结构是否存在（用于确认没被样式改坏）
            structure: {
                navBar: !!document.getElementById('taro-navigation-bar'),
                verifyInput: !!document.querySelector('.verify-input'),
                spellingHint: !!document.querySelector('.spelling-hint'),
                revTop: !!document.querySelector('.rev-top'),
                taroPages: document.querySelectorAll('.taro_page.taro_page_show').length,
                buttons: document.querySelectorAll('button').length
            },
            // 首屏可见文本片段，用于判断停在哪一步
            textSample: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 260)
        };
        return findings;
    });
}

(async () => {
    const args = parseArgs(process.argv);
    if (!args.base || !args.out) {
        console.error('用法: node capture_study.js --base <url> --out <dir> [--theme standard]');
        process.exit(2);
    }
    const theme = args.theme || 'standard';
    const outDir = path.resolve(args.out);
    fs.mkdirSync(outDir, { recursive: true });

    const browser = await chromium.launch({ executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const errors = [];
    page.on('pageerror', function (e) { errors.push(String(e).slice(0, 300)); });

    await page.addInitScript(function (value) {
        try { localStorage.setItem('memo_ui_style', value); } catch (e) {}
        try { localStorage.setItem('theme', 'light'); } catch (e) {}
    }, theme);

    await page.goto(args.base, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);

    // 进入学习界面：学习界面不是独立路由，而是**磁贴的一个图表选项**。
    // 走真实用户路径：选 .chart-selector 的 `study-web` 值并触发 change 事件。
    // 这样不修改任何 DOM 结构，只是模拟用户在下拉框里选“背单词”。
    const selector = page.locator('.tile:not([style*="display: none"]) .chart-selector').first();
    if (await selector.count()) {
        await selector.selectOption('study-web');
        await selector.dispatchEvent('change');
    } else {
        errors.push('找不到可见磁贴的 .chart-selector，无法进入学习界面');
    }
    await page.waitForTimeout(5000);

    const report = { theme: theme, base: args.base, stages: [] };

    // 主壳截图
    await page.screenshot({ path: path.join(outDir, 'shell@' + theme + '.png') });
    report.stages.push({ name: 'shell', ok: true });

    // 找到学习 iframe。未登录时墨墨会先加载 accounts 登录页（也在 iframe 里），
    // 因此这里要放宽匹配：只要不是主 frame，就当作学习区的 frame 来处理。
    const mainFrame = page.mainFrame();
    const frames = page.frames().filter(function (f) { return f !== mainFrame; });
    report.frames = page.frames().map(function (f) { return f.url(); });

    if (!frames.length) {
        report.stage = 'no-iframe';
        console.log(JSON.stringify(report, null, 2));
        await browser.close();
        console.log('STUDY_CAPTURE_NO_IFRAME');
        return;
    }

    const frame = frames[0];
    report.iframeUrl = frame.url();

    // 等 iframe 内容真正绘制
    await page.waitForTimeout(3000);

    const shot = path.join(outDir, 'study-' + (report.stage || 'state') + '@' + theme + '.png');
    await page.screenshot({ path: shot });
    const findings = await frameReport(frame);
    report.frame = findings;
    report.stage = findings && /登录|login|手机号|密码/.test(findings.textSample || '')
        ? 'login'
        : 'study';

    // 关键：注入的皮肤是否按主题正确分流
    if (findings) {
        if (theme === 'standard' && !findings.hasMemoStandard) {
            errors.push('主主题下 iframe 缺少 html.memo-standard');
        }
        if (theme === 'notebook' && !findings.hasMemoNotebook) {
            errors.push('手账主题下 iframe 缺少 html.memo-notebook');
        }
        if (theme === 'notebook' && findings.injectedLinks.some(function (l) {
            return /maimemo-standard/.test(l.href || '');
        })) {
            errors.push('手账主题下加载了 maimemo-standard.css（跨主题泄漏）');
        }
    }

    report.errors = errors;
    fs.writeFileSync(path.join(outDir, 'study-report@' + theme + '.json'),
        JSON.stringify(report, null, 2), 'utf-8');

    console.log(JSON.stringify({
        theme: theme,
        stage: report.stage,
        iframeUrl: report.iframeUrl,
        frame: findings,
        errors: errors
    }, null, 2));

    await context.close();
    await browser.close();
    console.log(errors.length ? 'STUDY_CAPTURE_ERRORS' : 'STUDY_CAPTURE_OK');
})();