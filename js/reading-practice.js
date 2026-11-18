/* Memo Superform - 近期词汇 → 四六级仔细阅读练习（业务逻辑层，无界面）
 * =====================================================================
 * 只负责：提示词构造、AI 调用编排、结构校验、独立审题、确定性判分、存储。
 * 不碰 DOM、不拼 HTML、不 innerHTML —— 模型输出一律当不可信数据，只做
 * JSON 解析与字段白名单。
 *
 * 六条不能退让的约束：
 *
 * 1. **判分只认冻结答案**：generate 时把每题答案冻进 practice.frozenAnswers，
 *    grade 永远以它为准。之后有人改动 questions[i].answer 也不会改变判分，
 *    更不会为了判分再问一次 AI。
 * 2. **两遍 AI，互相独立**：第一遍出题，第二遍只喂「文章 + 题干 + 选项」
 *    （不含答案/依据/解析），让它独立判断唯一最佳答案。审查结论写进
 *    practice.generation.reviewNotes；AI 自检不是证明，结论只作为参考记录。
 * 3. **校不过就不许提交**：validate 失败 → save/submit 拒绝；isSubmittable
 *    要求 validate 通过且 review 通过。
 * 4. **取消与迟到**：每次 generate 分配递增的 requestId/generation，新任务
 *    立刻取消旧任务；旧任务的迟到响应不得覆盖新结果。没有自动重试循环。
 * 5. **账号隔离**：存储键与练习对象都带 accountScope，切号读不到上一账号的
 *    草稿与记录。
 * 6. **只读墨墨**：这一层完全不碰墨墨写接口，也不换算真实四六级分数、
 *    不把阅读正确率当单词掌握率。
 *
 * AI 调用注入（离线测试）：
 *   generate({..., aiCall})                        显式参数优先
 *   MemoReadingPractice.setDeps({aiCall})          模块内注入
 *   window.MemoReadingPracticeDeps = { aiCall }    全局覆盖
 * 产品路径没有这些覆盖时走 AIAPI.getConfig() + POST /proxy/ai。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MemoReadingPractice = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = '20261118-reading-practice-v0.95';
    var SCHEMA = 'memo-reading-v1';
    var PROMPT_VERSION = 'reading-prompt-v1-20261118';
    var REVIEW_PROMPT_VERSION = 'reading-review-v1-20261118';
    var STORE_PREFIX = 'memo_reading_v1';
    var QUESTION_COUNT = 5;
    var OPTION_KEYS = ['A', 'B', 'C', 'D'];
    var QUESTION_TYPES = ['detail', 'main', 'infer', 'vocab', 'attitude'];
    var COMPLETENESS = ['complete', 'partial', 'stale', 'empty'];
    var THEMES = ['校园', '科技', '环境', '教育', '社会生活'];
    var MIN_QUOTE_TOKENS = 3;
    var FENCE = String.fromCharCode(96, 96, 96);

    var LEVELS = [
        { key: 'cet4', label: '四级', targetWords: 320, allowed: [300, 350] },
        { key: 'cet6', label: '六级', targetWords: 425, allowed: [400, 450] }
    ];

    /* ================= 小工具 ================= */

    function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

    function str(value) {
        if (value === null || value === undefined) return '';
        return String(value);
    }

    function trimmed(value) { return str(value).trim(); }

    function toInt(value, fallback) {
        var num = Number(value);
        if (!isFinite(num)) return fallback;
        return Math.trunc(num);
    }

    function findLevel(levelKey) {
        for (var i = 0; i < LEVELS.length; i += 1) {
            if (LEVELS[i].key === levelKey) return LEVELS[i];
        }
        return null;
    }

    function nowIso() { return new Date().toISOString(); }

    function makeId(prefix) {
        var rand = Math.random().toString(36).slice(2, 8);
        return (prefix || 'rp') + '-' + Date.now().toString(36) + '-' + rand;
    }

    function escapeRegex(text) {
        return String(text).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    }

    /* ================= 文本：分词、规范化、包含判定 ================= */

    /* 统一小写、把所有非字母数字/apostrophe/hyphen/空白的字符换成空格，再折叠空白。
     * 归一化只用于比较，绝不回写展示文本。 */
    function normalizeForMatch(text) {
        return str(text)
            .toLowerCase()
            .replace(/[\u2018\u2019\u02bc]/g, "'")
            .replace(/[\u2010-\u2015\u2212]/g, '-')
            .replace(/[^a-z0-9'\-\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /* 常见虚词表：用来判断一段引文里有没有实词。
     * 只用于"这条引文能不能当定位依据"，不参与其它匹配逻辑。 */
    var STOP_WORDS = [
        'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this',
        'these', 'those', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from',
        'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'they',
        'them', 'their', 'we', 'our', 'you', 'your', 'he', 'she', 'his', 'her',
        'not', 'no', 'so', 'such', 'into', 'over', 'under', 'about', 'which', 'who',
        'what', 'when', 'where', 'how', 'also', 'more', 'most', 'some', 'any', 'all',
        'can', 'could', 'would', 'should', 'may', 'might', 'will', 'do', 'does', 'did',
        'there', 'here', 'up', 'down', 'out', 'off', 'have', 'has', 'had'
    ];

    /* 词元化：按空白切分后把连字符再拆开（'well-known' → well, known），
     * 比较单位是词元，所以 "art" 永远不会匹配到 "heart"。 */
    function tokenize(text) {
        var normalized = normalizeForMatch(text);
        if (!normalized) return [];
        var out = [];
        normalized.split(' ').forEach(function (chunk) {
            if (!chunk) return;
            chunk.split('-').forEach(function (piece) {
                var token = piece.replace(/^'+|'+$/g, '');
                if (token) out.push(token);
            });
        });
        return out;
    }

    /* 连续子序列匹配：needle 必须作为连续词元序列出现在 haystack 中。 */
    function containsTokens(haystack, needle) {
        if (!needle.length || needle.length > haystack.length) return false;
        var limit = haystack.length - needle.length;
        for (var i = 0; i <= limit; i += 1) {
            var hit = true;
            for (var j = 0; j < needle.length; j += 1) {
                if (haystack[i + j] !== needle[j]) { hit = false; break; }
            }
            if (hit) return true;
        }
        return false;
    }

    function countEnglishWords(text) {
        var matches = str(text).match(/[A-Za-z][A-Za-z'\u2019\-]*/g);
        return matches ? matches.length : 0;
    }

    function practiceWordCount(paragraphs) {
        var total = 0;
        (Array.isArray(paragraphs) ? paragraphs : []).forEach(function (paragraph) {
            total += countEnglishWords(paragraph);
        });
        return total;
    }

    /* 目标词在段落中的字符偏移，只用于界面上定位；找不到给 -1。
     * 用词边界构造正则，绝不用裸 substring 判定。 */
    function findSurfaceOffset(paragraph, surface) {
        var needle = tokenize(surface);
        if (!needle.length) return -1;
        var text = str(paragraph);
        var body = needle.map(escapeRegex).join('[^A-Za-z0-9]+');
        var pattern = new RegExp('(^|[^A-Za-z0-9])(' + body + ')(?![A-Za-z0-9])', 'i');
        var match = pattern.exec(text);
        if (!match) return -1;
        return match.index + match[1].length;
    }

    /* ================= 提示词 ================= */

    function levelBrief(level) {
        if (level.key === 'cet6') {
            return [
                '难度目标：大学英语六级（CET-6）仔细阅读。它必须比四级明显更难，而不是把四级文章写长一点。',
                '词汇：允许并鼓励六级大纲词汇与抽象名词（如 sustainability, incentive, scrutiny, resilient, discrepancy），',
                '  但不要刻意堆砌生僻词；同一概念不要反复用同一个简单词。',
                '句法：多用从句嵌套、非谓语结构、名词化、插入语与倒装，平均句长明显高于四级；',
                '  但每句仍须语法正确、可解析，禁止为了复杂而写病句。',
                '信息密度：一个句子常同时承载两个以上命题，需要读者自行拆分；段与段之间的论证关系更隐含。',
                '推断难度：至少 2 道题需要跨句或跨段整合，或识别作者态度、让步与反驳，不能只在原文找同义句。',
                '干扰项：要有真正像对的错项（研究范围被扩大、相关被说成因果、两方观点被对调），不能一眼假。'
            ].join('\n');
        }
        return [
            '难度目标：大学英语四级（CET-4）仔细阅读。',
            '词汇：以四级大纲词汇为主，可以有少量六级词，但不靠生词制造难度。',
            '句法：以简单句、并列句和常见定语/状语从句为主，允许少量非谓语结构，长句要能一遍读懂。',
            '信息密度：一句一个主要命题，指代明确，逻辑连接词（however, therefore, for example）清晰。',
            '推断难度：以细节定位与同义改写为主，最多 1 道需要简单推断的题。',
            '干扰项：错在具体事实上（对象错位、数字错、因果颠倒），不靠晦涩措辞。'
        ].join('\n');
    }

    function buildGenerationPrompt(input) {
        var level = input.level;
        var words = input.words || [];
        var theme = input.theme || THEMES[0];
        var targetWords = input.targetWords || level.targetWords;
        var allowed = level.allowed;
        var wordLines = words.map(function (word, index) {
            return '  ' + (index + 1) + '. ' + word.spelling + (word.vocId ? '  (vocId=' + word.vocId + ')' : '');
        }).join('\n');

        return [
            '你是一位资深四六级命题人。请生成一篇原创英文文章和 5 道单选题，用于「' + level.label + '」仔细阅读训练。',
            '',
            '## 一、文章',
            '- 原创英文，不得抄袭或改写任何已发表文章；不要编造研究出处、专家姓名或引语、机构报告、官方背书。',
            '- 必须有英文标题（title）。',
            '- 自然分段（4~6 段），全文围绕一个统一主题：' + theme + '。',
            '- 全文约 ' + targetWords + ' 个英文单词，必须落在 ' + allowed[0] + '~' + allowed[1] + ' 词之间（按空白分隔的英文单词计）。',
            '- 这是四六级 Section C 仔细阅读（Careful Reading），不是 Section B 段落匹配：',
            '  · 禁止写成上千词的长文；',
            '  · 禁止出十道段落匹配题；',
            '  · 禁止让读者选段落字母（例如 Which paragraph contains...）；',
            '  · 禁止任何「一个段落可以对应多道题」的匹配规则。',
            '',
            '## 二、目标词',
            '下面是学习者最近学过、需要复现的单词。请把它们自然融入正文（不要列成清单，不要加粗，不要改变词性到不自然）：',
            wordLines,
            '- 允许词形变化（复数、时态、派生），但你必须记录实际出现在正文里的那个形式（surface）。',
            '- 每个目标词至少出现一次，位置分散在不同段落。',
            '',
            '## 三、题目（结构必须精确）',
            '- 恰好 5 道单选题；每一道都是四选一。',
            '- 每题恰好 4 个选项，键名必须是 A、B、C、D，各出现一次。',
            '- 每题有且只有一个最佳答案，其余三项必须明确不成立。',
            '- 细节理解为主，合理搭配主旨题、推断题、词义题、态度题，至少覆盖 3 种题型。',
            '- 5 道题的依据必须分布在不同的段落，不得集中在同一段。',
            '',
            '## 四、答案与干扰项质量',
            '- 正确项必须能在原文定位到具体依据：给出段落序号（从 0 开始）与原文原句（quote 必须逐字摘自该段）。',
            '- 干扰项要合理但不成立，错因限于：对象错置、范围扩大、因果颠倒、细节混淆、无依据推断。',
            '- 不得靠语法错误、荒谬内容、异常长度（明显更长或更短）凑数；四个选项的长度与信息量尽量平衡。',
            '- 不得靠固定答案位置（例如 5 题答案都是 B），也不得机械照抄原句泄露答案。',
            '',
            '## 五、难度分层',
            levelBrief(level),
            '',
            '## 六、输出格式',
            '只输出一个 JSON 对象，不要 Markdown 代码块，不要任何解释文字。字段如下：',
            '{',
            '  "title": "英文标题",',
            '  "paragraphs": ["第一段", "第二段", "..."],',
            '  "targetWords": [',
            '    {"vocId": "上面给的 vocId", "spelling": "原形", "surface": "正文里实际出现的形式", "paragraphIndex": 0}',
            '  ],',
            '  "questions": [',
            '    {"id": "q1", "stem": "题干",',
            '     "options": [{"key": "A", "text": "..."}, {"key": "B", "text": "..."},',
            '                 {"key": "C", "text": "..."}, {"key": "D", "text": "..."}],',
            '     "answer": "A",',
            '     "evidence": {"paragraphIndex": 0, "quote": "该段原文原句"},',
            '     "explanation": "为什么这个答案对（中文）",',
            '     "distractors": [{"key": "B", "why": "为什么错（中文）"}, {"key": "C", "why": "..."}, {"key": "D", "why": "..."}],',
            '     "type": "detail" 或 main 或 infer 或 vocab 或 attitude}',
            '  ]',
            '}',
            '',
            '注意：paragraphIndex 从 0 开始；quote 必须与对应段落中的文字逐字一致；answer 只能是 A/B/C/D 之一。',
            '这篇练习会标注「AI 原创模拟练习」，所以不要声称它来自任何真实考试。'
        ].join('\n');
    }

    /* 第二遍独立审题：只喂文章 + 题干 + 选项。
     * 刻意不带第一遍的 answer/evidence/explanation/distractors，否则它只是在附和一个既有答案。 */
    function buildReviewPrompt(practice) {
        var paragraphs = (practice.paragraphs || []).map(function (paragraph, index) {
            return '[P' + index + '] ' + paragraph;
        }).join('\n\n');
        var questions = (practice.questions || []).map(function (question) {
            var options = (question.options || []).map(function (option) {
                return '    ' + option.key + '. ' + option.text;
            }).join('\n');
            return 'Q' + question.id + ': ' + question.stem + '\n' + options;
        }).join('\n\n');

        return [
            '你是一位独立审题人。下面是一篇英语文章和 5 道单选题，没有给出参考答案。',
            '请完全独立地判断每道题是否合格。',
            '',
            '## 文章',
            paragraphs,
            '',
            '## 题目',
            questions,
            '',
            '## 逐题判断以下四点',
            '1. 是否存在唯一最佳答案（有且只有一个选项能被原文充分支持，其余三项明确不成立）。',
            '2. 你认定的最佳答案能否在原文定位到具体依据（给出段落序号与依据原句片段）。',
            '3. 若有两个或以上选项都说得通、或没有任何选项能被支持，标记为不合格。',
            '4. 干扰项是否合理（像对的但确实错），而不是荒谬、语法错或与题干无关。',
            '',
            '另外整体判断：题干是否清晰无歧义；是否有题目不读文章也能靠常识答对；',
            '正确项是否明显比其他三项长（长度泄题）。',
            '',
            '## 输出格式',
            '只输出一个 JSON 对象，不要 Markdown 代码块，不要解释文字：',
            '{',
            '  "overall": "ok" 或 "problems",',
            '  "notes": "整体结论（中文，200 字以内）",',
            '  "questions": [',
            '    {"id": "q1", "unique": true, "bestAnswer": "A", "evidenceSupported": true,',
            '     "distractorsReasonable": true, "paragraphIndex": 2, "quote": "依据原句片段", "note": "简述"}',
            '  ]',
            '}',
            '不确定时请把 unique 设为 false，不要为了通过而放水。'
        ].join('\n');
    }

    /* ================= AI 调用 ================= */

    function aiError(message, code) {
        var error = new Error(message);
        error.code = code || 'ai-unavailable';
        return error;
    }

    /* 产品路径：复用 js/api.js 的 AIAPI 配置，走本机 /proxy/ai。
     * AIAPI 是顶层 const（全局词法绑定），不是 window 属性，只能用 typeof 判断。 */
    async function defaultAiCall(request) {
        var api = (typeof AIAPI !== 'undefined' ? AIAPI : null);
        if (!api || typeof api.getConfig !== 'function') {
            throw aiError('AI 服务未就绪，请刷新页面后重试', 'ai-unavailable');
        }
        var config = api.getConfig() || {};
        if (config.provider !== 'codex' && !config.apiKey) {
            throw aiError('请先在设置中配置 AI API Key', 'missing-ai-key');
        }
        if (typeof fetch !== 'function') {
            throw aiError('当前环境不支持网络请求', 'ai-unavailable');
        }
        var body = {
            model: config.model,
            messages: request.messages,
            temperature: typeof request.temperature === 'number' ? request.temperature : 0.7,
            stream: false
        };
        if (request.responseFormat) body.response_format = { type: 'json_object' };
        var response = await fetch('/proxy/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'MemoSuperform' },
            body: JSON.stringify({
                provider: config.provider,
                endpoint: config.endpoint,
                apiKey: config.apiKey,
                noMemory: true,
                body: body
            }),
            signal: request.signal
        });
        if (!response.ok) throw aiError('AI 接口错误：' + response.status, 'ai-http');
        var data = await response.json();
        if (!data || data.error) throw aiError(str(data && data.error) || 'AI 返回错误', 'ai-http');
        var choice = data.choices && data.choices[0];
        var content = choice && choice.message && choice.message.content;
        if (typeof content !== 'string' || !content.trim()) {
            throw aiError('AI 没有返回可用内容', 'ai-empty');
        }
        return { content: content, model: config.model, provider: config.provider };
    }

    var injected = {};

    function resolveAiCall(explicit) {
        if (typeof explicit === 'function') return explicit;
        if (typeof injected.aiCall === 'function') return injected.aiCall;
        var scope = typeof globalThis !== 'undefined' ? globalThis : null;
        if (scope && scope.MemoReadingPracticeDeps && typeof scope.MemoReadingPracticeDeps.aiCall === 'function') {
            return scope.MemoReadingPracticeDeps.aiCall;
        }
        return defaultAiCall;
    }

    function setDeps(partial) {
        injected = Object.assign({}, injected, partial || {});
        return Object.assign({}, injected);
    }

    function resetDeps() {
        injected = {};
        return {};
    }

    async function callAi(aiCall, request) {
        var raw = await aiCall(request);
        if (typeof raw === 'string') return { content: raw, model: '', provider: '' };
        if (isObject(raw) && typeof raw.content === 'string') {
            return { content: raw.content, model: trimmed(raw.model), provider: trimmed(raw.provider) };
        }
        throw aiError('AI 返回的数据结构异常', 'ai-shape');
    }

    /* ================= 解析模型输出（不可信数据） ================= */

    function extractJson(text) {
        var content = str(text).trim();
        if (!content) return { ok: false, reason: 'empty-ai-content', message: 'AI 没有返回内容' };
        if (content.charAt(0) === '\uFEFF') content = content.slice(1).trim();
        if (content.indexOf(FENCE) === 0) {
            var afterOpen = content.slice(FENCE.length);
            if (/^json/i.test(afterOpen)) afterOpen = afterOpen.replace(/^json/i, '');
            var closeAt = afterOpen.lastIndexOf(FENCE);
            content = (closeAt >= 0 ? afterOpen.slice(0, closeAt) : afterOpen).trim();
        }
        try {
            return { ok: true, value: JSON.parse(content) };
        } catch (error) { /* 继续尝试截取花括号区间 */ }
        var start = content.indexOf('{');
        var end = content.lastIndexOf('}');
        if (start >= 0 && end > start) {
            try {
                return { ok: true, value: JSON.parse(content.slice(start, end + 1)) };
            } catch (error2) {
                return { ok: false, reason: 'parse-error', message: 'AI 返回的 JSON 无法解析：' + error2.message };
            }
        }
        return { ok: false, reason: 'parse-error', message: 'AI 返回的内容里找不到 JSON 对象' };
    }

    /* 去掉控制字符并截断。模型文本一律当纯文本处理，绝不拼 HTML。 */
    function safeText(value, maxLength) {
        var text = str(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim();
        if (maxLength && text.length > maxLength) text = text.slice(0, maxLength);
        return text;
    }

    /* 字段白名单化：只复制已知字段，忽略一切多余键。 */
    function normalizePractice(raw, context) {
        var warnings = [];
        var level = context.level;
        var source = isObject(raw) ? raw : {};
        var paragraphs = (Array.isArray(source.paragraphs) ? source.paragraphs : [])
            .map(function (paragraph) { return safeText(paragraph, 20000); })
            .filter(function (paragraph) { return paragraph.length > 0; });

        var questions = (Array.isArray(source.questions) ? source.questions : []).map(function (item, index) {
            var options = [];
            var rawOptions = Array.isArray(item && item.options) ? item.options : [];
            rawOptions.forEach(function (option, optionIndex) {
                if (options.length >= OPTION_KEYS.length) return;
                var text = typeof option === 'string'
                    ? safeText(option, 400)
                    : safeText(option && (option.text !== undefined ? option.text : option.content), 400);
                if (!text) return;
                var key = trimmed(option && option.key).toUpperCase();
                if (OPTION_KEYS.indexOf(key) < 0 || options.some(function (o) { return o.key === key; })) {
                    key = OPTION_KEYS[optionIndex] || '';
                }
                if (!key) return;
                options.push({ key: key, text: text });
            });
            var evidence = isObject(item && item.evidence) ? item.evidence : {};
            var distractors = (Array.isArray(item && item.distractors) ? item.distractors : [])
                .map(function (entry) {
                    return {
                        key: trimmed(entry && entry.key).toUpperCase(),
                        why: safeText(entry && (entry.why !== undefined ? entry.why : entry.reason), 400)
                    };
                })
                .filter(function (entry) { return entry.key && entry.why; });
            var type = trimmed(item && item.type).toLowerCase();
            if (QUESTION_TYPES.indexOf(type) < 0) type = 'detail';
            var answer = trimmed(item && item.answer).toUpperCase();
            return {
                id: trimmed(item && item.id) || ('q' + (index + 1)),
                stem: safeText(item && item.stem, 500),
                options: options,
                answer: answer ? answer.slice(0, 1) : '',
                evidence: {
                    paragraphIndex: toInt(evidence.paragraphIndex, -1),
                    quote: safeText(evidence.quote, 600)
                },
                explanation: safeText(item && item.explanation, 1200),
                distractors: distractors,
                type: type
            };
        });

        var knownIds = Object.create(null);
        (context.candidates || []).forEach(function (candidate) {
            if (candidate && candidate.vocId !== undefined && candidate.vocId !== null) {
                knownIds[String(candidate.vocId)] = candidate;
            }
        });

        var targetWords = (Array.isArray(source.targetWords) ? source.targetWords : []).map(function (word) {
            var vocId = trimmed(word && (word.vocId !== undefined ? word.vocId : word.voc_id));
            var surface = safeText(word && word.surface, 80);
            var paragraphIndex = toInt(word && word.paragraphIndex, -1);
            var paragraph = paragraphIndex >= 0 && paragraphIndex < paragraphs.length ? paragraphs[paragraphIndex] : '';
            var known = vocId && knownIds[vocId] ? knownIds[vocId] : null;
            if (vocId && !known) warnings.push('模型返回了不在候选集合里的 vocId：' + vocId);
            if (!surface || !paragraph) return null;
            var offset = findSurfaceOffset(paragraph, surface);
            if (offset < 0) {
                warnings.push('目标词「' + surface + '」没有出现在第 ' + paragraphIndex + ' 段');
                return null;
            }
            return {
                vocId: vocId,
                spelling: (known && known.spelling) || safeText(word && word.spelling, 80) || surface,
                surface: surface,
                paragraphIndex: paragraphIndex,
                charOffset: offset
            };
        }).filter(Boolean);

        var practice = {
            schema: SCHEMA,
            id: context.id || makeId('rp'),
            createdAt: context.createdAt || nowIso(),
            level: level.key,
            levelLabel: level.label,
            /* 本篇所用的题材。界面上要显示，重做时也要沿用同一个题材。 */
            theme: THEMES.indexOf(context.theme) >= 0 ? context.theme : THEMES[0],
            title: safeText(source.title, 300),
            paragraphs: paragraphs,
            wordCount: practiceWordCount(paragraphs),
            source: Object.assign({}, context.source || {}),
            targetWords: targetWords,
            questions: questions,
            generation: {
                provider: context.provider || '',
                model: context.model || '',
                promptVersion: PROMPT_VERSION,
                reviewedAt: null,
                reviewNotes: '',
                warnings: warnings,
                requestId: context.requestId || '',
                reviewed: false
            },
            accountScope: context.accountScope || 'anonymous'
        };
        /* 冻结答案：判分的唯一依据。之后 questions[i].answer 再怎么改都不影响。 */
        practice.frozenAnswers = questions.map(function (question) {
            return { id: question.id, answer: question.answer };
        });
        practice.disclaimer = 'AI 原创模拟练习，与真实考试无关。阅读正确率不等于单词掌握率。';
        return practice;
    }

    /* ================= 校验 ================= */

    function validate(practice) {
        var errors = [];
        var warnings = [];
        function fail(code) { errors.push(code); return false; }

        if (!isObject(practice)) return { ok: false, errors: ['practice 不是对象'], warnings: warnings };

        if (practice.schema !== SCHEMA) fail('schema 必须是 ' + SCHEMA + '，当前是 ' + str(practice.schema));
        if (!trimmed(practice.id)) fail('缺少 id');
        if (!trimmed(practice.createdAt) || isNaN(Date.parse(str(practice.createdAt)))) fail('createdAt 不是有效时间');
        if (!trimmed(practice.accountScope)) fail('缺少 accountScope');

        var level = findLevel(practice.level);
        if (!level) {
            fail('未知的等级：' + str(practice.level));
        } else if (practice.levelLabel !== level.label) {
            warnings.push('levelLabel 与等级不一致：' + str(practice.levelLabel));
        }

        if (!trimmed(practice.title)) fail('缺少标题');
        else if (countEnglishWords(practice.title) > 30) warnings.push('标题过长');

        var paragraphs = Array.isArray(practice.paragraphs) ? practice.paragraphs : null;
        if (!paragraphs) fail('paragraphs 必须是数组');
        if (paragraphs) {
            if (paragraphs.length < 2) fail('正文至少需要 2 段');
            paragraphs.forEach(function (paragraph, index) {
                if (typeof paragraph !== 'string' || !paragraph.trim()) {
                    fail('第 ' + index + ' 段为空或不是字符串');
                }
            });
            var actualWords = practiceWordCount(paragraphs);
            if (level && (actualWords < level.allowed[0] || actualWords > level.allowed[1])) {
                fail('正文字数 ' + actualWords + ' 不在' + level.label + '允许区间 ' +
                    level.allowed[0] + '~' + level.allowed[1] + ' 内');
            }
            if (practice.wordCount !== actualWords) {
                fail('wordCount 冻结值 ' + str(practice.wordCount) + ' 与实际词数 ' + actualWords + ' 不一致');
            }
        }

        var source = practice.source;
        if (!isObject(source)) fail('缺少 source');
        else {
            if (!trimmed(source.rangeKey)) fail('source.rangeKey 缺失');
            if (COMPLETENESS.indexOf(str(source.completeness)) < 0) {
                fail('source.completeness 必须是 ' + COMPLETENESS.join('/'));
            }
        }

        var paragraphList = paragraphs || [];
        var questionIds = Object.create(null);
        var stemKeys = Object.create(null);
        var questions = Array.isArray(practice.questions) ? practice.questions : null;

        if (!questions) fail('questions 必须是数组');
        else {
            if (questions.length !== QUESTION_COUNT) {
                fail('题目数量必须是 ' + QUESTION_COUNT + '，当前是 ' + questions.length);
            }
            questions.forEach(function (question, index) {
                var label = '第 ' + (index + 1) + ' 题';
                if (!isObject(question)) { fail(label + ' 不是对象'); return; }

                var id = trimmed(question.id);
                if (!id) fail(label + ' 缺少 id');
                else if (questionIds[id]) fail(label + ' 的 id 重复：' + id);
                else questionIds[id] = true;

                var stem = trimmed(question.stem);
                if (!stem) fail(label + ' 题干为空');
                else if (countEnglishWords(stem) < 4) fail(label + ' 题干过短，无法构成完整问题');
                else {
                    var stemKey = normalizeForMatch(stem);
                    if (stemKeys[stemKey]) fail(label + ' 与第 ' + stemKeys[stemKey] + ' 题题干重复');
                    else stemKeys[stemKey] = index + 1;
                }
                if (QUESTION_TYPES.indexOf(str(question.type)) < 0) {
                    fail(label + ' 题型非法：' + str(question.type));
                }

                var options = Array.isArray(question.options) ? question.options : null;
                if (!options) fail(label + ' 缺少选项数组');
                else {
                    if (options.length !== OPTION_KEYS.length) {
                        fail(label + ' 必须有且只有 4 个选项，当前 ' + options.length + ' 个');
                    }
                    var seenKeys = [];
                    var seenTexts = [];
                    options.forEach(function (option, optionIndex) {
                        if (!isObject(option)) { fail(label + ' 第 ' + (optionIndex + 1) + ' 个选项不是对象'); return; }
                        var key = trimmed(option.key);
                        if (OPTION_KEYS.indexOf(key) < 0) fail(label + ' 选项键非法：' + key);
                        else if (seenKeys.indexOf(key) >= 0) fail(label + ' 选项键重复：' + key);
                        else seenKeys.push(key);
                        var text = trimmed(option.text);
                        if (!text) fail(label + ' 选项 ' + key + ' 文本为空');
                        else {
                            var textKey = normalizeForMatch(text);
                            if (!textKey) fail(label + ' 选项 ' + key + ' 没有有效英文内容');
                            else if (seenTexts.indexOf(textKey) >= 0) fail(label + ' 选项文本重复：' + key);
                            else seenTexts.push(textKey);
                        }
                    });
                    var missingKeys = OPTION_KEYS.filter(function (key) { return seenKeys.indexOf(key) < 0; });
                    if (missingKeys.length && options.length === OPTION_KEYS.length) {
                        fail(label + ' 选项键必须恰好是 A/B/C/D，缺少 ' + missingKeys.join(','));
                    }
                }

                var answer = trimmed(question.answer).toUpperCase();
                if (OPTION_KEYS.indexOf(answer) < 0) fail(label + ' answer 必须是 A~D，当前是 ' + str(question.answer));

                var evidence = isObject(question.evidence) ? question.evidence : null;
                if (!evidence) fail(label + ' 缺少 evidence');
                else {
                    var paragraphIndex = evidence.paragraphIndex;
                    if (typeof paragraphIndex !== 'number' || !isFinite(paragraphIndex) ||
                        paragraphIndex < 0 || paragraphIndex >= paragraphList.length ||
                        Math.floor(paragraphIndex) !== paragraphIndex) {
                        fail(label + ' evidence.paragraphIndex 非法：' + str(paragraphIndex));
                    } else {
                        var quoteText = trimmed(evidence.quote);
                        var quoteTokens = tokenize(quoteText);
                        if (!quoteText) fail(label + ' evidence.quote 为空');
                        else if (quoteTokens.length < MIN_QUOTE_TOKENS) {
                            fail(label + ' evidence.quote 太短（至少 ' + MIN_QUOTE_TOKENS + ' 个词），无法作为定位依据');
                        } else if (!containsTokens(tokenize(paragraphList[paragraphIndex]), quoteTokens)) {
                            fail(label + ' evidence.quote 没有出现在第 ' + paragraphIndex + ' 段中');
                        } else {
                            /* 光"词元连续出现"太松：跨句拼接（"... later. One university"）
                             * 或一堆虚词（"the end of"）都能过，定位句就失去意义。
                             * 这里再要求：
                             *   1. 至少含一个实词（非停用词）；
                             *   2. 整段引文确实落在原文的一处连续文本里（按原样子串比对，
                             *      允许空白不同），而不是跨句拼接出来的。 */
                            var hasContentWord = quoteTokens.some(function (token) {
                                return STOP_WORDS.indexOf(token) < 0;
                            });
                            if (!hasContentWord) {
                                fail(label + ' evidence.quote 全是虚词，不能作为定位依据');
                            } else {
                                var haystack = String(paragraphList[paragraphIndex] || '')
                                    .replace(/\s+/g, ' ').toLowerCase();
                                var needle = quoteText.replace(/\s+/g, ' ').toLowerCase();
                                if (haystack.indexOf(needle) < 0) {
                                    fail(label + ' evidence.quote 不是原文中的连续片段（疑似跨句拼接）');
                                }
                            }
                        }
                    }
                }

                if (!trimmed(question.explanation)) fail(label + ' 缺少 explanation');

                var distractors = Array.isArray(question.distractors) ? question.distractors : null;
                if (!distractors) fail(label + ' 缺少 distractors');
                else if (OPTION_KEYS.indexOf(answer) >= 0) {
                    var providedKeys = distractors.map(function (entry) {
                        return trimmed(entry && entry.key).toUpperCase();
                    });
                    OPTION_KEYS.forEach(function (key) {
                        if (key === answer) return;
                        if (providedKeys.indexOf(key) < 0) fail(label + ' 干扰项缺少 ' + key + ' 的错因说明');
                    });
                    distractors.forEach(function (entry) {
                        if (entry && !trimmed(entry.why)) fail(label + ' 干扰项 ' + str(entry.key) + ' 的 why 为空');
                    });
                }
            });

            /* 冻结答案必须与题目**一一对应**：只校验"长度相等 + id 存在"是可以被
             * 重复 id 绕过的（5 条记录里塞两个 q1，q5 就落在冻结表外，
             * 判分回落到可被篡改的 questions[].answer）。这里要求：
             *   1. id 不得重复；
             *   2. 冻结 id 集合与题目 id 集合完全一致；
             *   3. 冻结值与题目展示的 answer 一致（否则用户按显示的正确答案作答却判错）。 */
            var frozen = practice.frozenAnswers;
            if (!Array.isArray(frozen) || frozen.length !== questions.length) {
                fail('缺少冻结答案 frozenAnswers');
            } else {
                var frozenSeen = Object.create(null);
                var frozenOk = true;
                frozen.forEach(function (entry) {
                    var fid = entry ? trimmed(entry.id) : '';
                    if (!fid || !questionIds[fid]) {
                        fail('冻结答案里有未知题目 id');
                        frozenOk = false;
                    } else if (frozenSeen[fid]) {
                        fail('冻结答案里题目 id 重复：' + fid + '（有题目会脱离冻结）');
                        frozenOk = false;
                    } else {
                        frozenSeen[fid] = trimmed(entry.answer).toUpperCase();
                        if (OPTION_KEYS.indexOf(frozenSeen[fid]) < 0) {
                            fail('冻结答案 ' + fid + ' 不是 A~D');
                            frozenOk = false;
                        }
                    }
                });
                if (frozenOk) {
                    Object.keys(questionIds).forEach(function (qid) {
                        if (!(qid in frozenSeen)) fail('题目 ' + qid + ' 没有冻结答案');
                    });
                    questions.forEach(function (question, index) {
                        var qid = trimmed(question.id);
                        var shown = trimmed(question.answer).toUpperCase();
                        if (qid in frozenSeen && frozenSeen[qid] !== shown) {
                            fail('第 ' + (index + 1) + ' 题冻结答案 ' + frozenSeen[qid] +
                                 ' 与题目答案 ' + shown + ' 不一致');
                        }
                    });
                }
            }

            var paragraphsUsed = [];
            questions.forEach(function (question) {
                var index = question && question.evidence ? question.evidence.paragraphIndex : -1;
                if (typeof index === 'number' && paragraphsUsed.indexOf(index) < 0) paragraphsUsed.push(index);
            });
            /* 覆盖度与答案分布是命题质量要求，不是"最好有"：
             * 题目全挤在一段、或全是同一种题型，这份练习就没有考查到整篇文章。
             * 因此从告警升级为硬失败——不合格的内容不能变成可提交的练习。 */
            if (paragraphList.length > 1) {
                var needParagraphs = Math.min(3, paragraphList.length);
                if (paragraphsUsed.length < needParagraphs) {
                    fail('5 道题的定位依据只覆盖了 ' + paragraphsUsed.length +
                         ' 段，要求至少覆盖 ' + needParagraphs + ' 段');
                }
            }
            var typeSeen = Object.create(null);
            questions.forEach(function (question) {
                var qtype = trimmed(question.type).toLowerCase();
                if (qtype) typeSeen[qtype] = true;
            });
            var typeCount = Object.keys(typeSeen).length;
            if (typeCount < 3) {
                fail('题型只有 ' + typeCount + ' 种（' + Object.keys(typeSeen).join('/') + '），要求至少 3 种');
            }
            /* 干扰项里不能出现正确答案，也不能重复——否则选项本身自相矛盾。 */
            questions.forEach(function (question, index) {
                var qAnswer = trimmed(question.answer).toUpperCase();
                var seenKey = Object.create(null);
                var list = Array.isArray(question.distractors) ? question.distractors : [];
                list.forEach(function (entry) {
                    var dkey = trimmed(entry && entry.key).toUpperCase();
                    if (!dkey) return;
                    if (dkey === qAnswer) {
                        fail('第 ' + (index + 1) + ' 题 干扰项里包含了正确答案 ' + qAnswer);
                    }
                    if (seenKey[dkey]) fail('第 ' + (index + 1) + ' 题 干扰项 ' + dkey + ' 重复');
                    seenKey[dkey] = true;
                });
            });
            var answers = questions.map(function (question) { return trimmed(question.answer).toUpperCase(); });
            if (answers.length > 2 && answers.every(function (value) { return value === answers[0]; })) {
                warnings.push('所有题目答案都是 ' + answers[0] + '，存在固定答案位置风险');
            }
        }

        var targetWords = Array.isArray(practice.targetWords) ? practice.targetWords : null;
        if (!targetWords) fail('targetWords 必须是数组');
        else if (!targetWords.length) fail('targetWords 为空，文章没有融入任何目标词');
        else {
            var seenVoc = Object.create(null);
            targetWords.forEach(function (word, index) {
                var label = '目标词 ' + (index + 1);
                if (!isObject(word)) { fail(label + ' 不是对象'); return; }
                var vocId = trimmed(word.vocId);
                if (!vocId) fail(label + ' 缺少 vocId');
                else if (seenVoc[vocId]) fail(label + ' 的 vocId 重复：' + vocId);
                else seenVoc[vocId] = true;
                var surface = trimmed(word.surface);
                if (!surface) { fail(label + ' 缺少 surface'); return; }
                var paragraphIndex = word.paragraphIndex;
                if (typeof paragraphIndex !== 'number' || !isFinite(paragraphIndex) ||
                    paragraphIndex < 0 || paragraphIndex >= paragraphList.length) {
                    fail(label + ' 的 paragraphIndex 非法：' + str(paragraphIndex));
                    return;
                }
                var surfaceTokens = tokenize(surface);
                if (!surfaceTokens.length) { fail(label + ' 的 surface 没有有效英文内容'); return; }
                if (!containsTokens(tokenize(paragraphList[paragraphIndex]), surfaceTokens)) {
                    fail(label + ' 的 surface「' + surface + '」没有出现在第 ' + paragraphIndex + ' 段');
                }
                if (typeof word.charOffset !== 'number' || word.charOffset < 0) {
                    warnings.push(label + ' 没有可用的 charOffset');
                }
            });
        }

        return { ok: errors.length === 0, errors: errors, warnings: warnings };
    }

    /* ================= 独立审题 ================= */

    function normalizeReview(raw) {
        var notes = [];
        var perQuestion = [];
        if (!isObject(raw)) return { overall: 'problems', notes: '审题结果不是对象', perQuestion: [] };
        var overall = trimmed(raw.overall).toLowerCase();
        if (overall !== 'ok' && overall !== 'problems') overall = 'problems';
        if (typeof raw.notes === 'string' && raw.notes.trim()) notes.push(safeText(raw.notes, 600));
        (Array.isArray(raw.questions) ? raw.questions : []).forEach(function (item) {
            if (!isObject(item)) return;
            var entry = {
                id: trimmed(item.id),
                unique: item.unique === true,
                bestAnswer: trimmed(item.bestAnswer).toUpperCase().slice(0, 1),
                evidenceSupported: item.evidenceSupported === true,
                distractorsReasonable: item.distractorsReasonable !== false,
                paragraphIndex: toInt(item.paragraphIndex, -1),
                quote: safeText(item.quote, 400),
                note: safeText(item.note, 400)
            };
            perQuestion.push(entry);
            if (!entry.unique) notes.push((entry.id || '?') + '：可能存在多个可成立选项');
            if (!entry.evidenceSupported) notes.push((entry.id || '?') + '：审题未能在原文定位到依据');
            if (!entry.distractorsReasonable) notes.push((entry.id || '?') + '：干扰项不合理');
        });
        return { overall: overall, notes: notes.join('；'), perQuestion: perQuestion };
    }

    /* 审题通过条件：overall=ok；每题 unique + evidenceSupported；
     * 审题人独立给出的最佳答案必须与冻结答案一致。AI 自检不是绝对正确的证明，
     * 这里只保证「不一致就不放行」。 */
    function reviewVerdict(practice, review) {
        var problems = [];
        var frozen = Object.create(null);
        (Array.isArray(practice.frozenAnswers) ? practice.frozenAnswers : []).forEach(function (entry) {
            if (entry && entry.id) frozen[trimmed(entry.id)] = trimmed(entry.answer).toUpperCase();
        });
        if (review.overall !== 'ok') problems.push('审题整体结论为 problems');
        if (!review.perQuestion.length) problems.push('审题没有返回逐题结论');

        /* 覆盖率：审题必须对**每一道题**都给出结论。只回 1 题也判 ok 的话，
         * 另外 4 题从未被独立审题，整篇照样能提交——审题就成了摆设。 */
        var questionIds = Object.keys(frozen);
        var reviewedIds = Object.create(null);
        review.perQuestion.forEach(function (entry) {
            var id = entry.id || '?';
            if (entry.id) reviewedIds[entry.id] = true;
            if (!entry.unique) problems.push(id + ' 不存在唯一最佳答案');
            if (!entry.evidenceSupported) problems.push(id + ' 的依据未能在原文成立');
            if (frozen[id] && entry.bestAnswer && frozen[id] !== entry.bestAnswer) {
                problems.push(id + ' 审题答案 ' + entry.bestAnswer + ' 与生成答案 ' + frozen[id] + ' 不一致');
            }
            if (frozen[id] && !entry.bestAnswer) problems.push(id + ' 审题没有给出最佳答案');
            if (!frozen[id]) problems.push(id + ' 不是本篇的题目');
        });
        questionIds.forEach(function (qid) {
            if (!reviewedIds[qid]) problems.push(qid + ' 没有被独立审题覆盖');
        });
        return { ok: problems.length === 0, problems: problems };
    }

    async function reviewSemantics(practice, options) {
        options = options || {};
        if (!isObject(practice) || !Array.isArray(practice.questions) || !practice.questions.length) {
            return { ok: false, reason: 'invalid-practice', notes: '练习对象不完整，无法审题', perQuestion: [] };
        }
        var aiCall = resolveAiCall(options.aiCall);
        var request = {
            purpose: 'review',
            promptVersion: REVIEW_PROMPT_VERSION,
            messages: [
                { role: 'system', content: '你是严格、独立的英语阅读理解审题人，只输出 JSON。' },
                { role: 'user', content: buildReviewPrompt(practice) }
            ],
            temperature: 0.2,
            responseFormat: true,
            signal: options.signal
        };
        var result;
        try {
            result = await callAi(aiCall, request);
        } catch (error) {
            var aborted = !!(error && (error.name === 'AbortError' || error.code === 'aborted'));
            return {
                ok: false, reason: aborted ? 'cancelled' : 'ai-error',
                notes: '审题调用失败：' + (error && error.message ? error.message : String(error)), perQuestion: []
            };
        }
        var parsed = extractJson(result.content);
        if (!parsed.ok) {
            return { ok: false, reason: parsed.reason, notes: parsed.message, perQuestion: [], model: result.model };
        }
        var review = normalizeReview(parsed.value);
        var verdict = reviewVerdict(practice, review);
        var notes = [];
        if (review.notes) notes.push(review.notes);
        verdict.problems.forEach(function (problem) { notes.push(problem); });
        return {
            ok: verdict.ok,
            reason: verdict.ok ? null : 'review-failed',
            notes: notes.join('；'),
            problems: verdict.problems,
            perQuestion: review.perQuestion,
            overall: review.overall,
            model: result.model,
            provider: result.provider,
            reviewedAt: nowIso(),
            promptVersion: REVIEW_PROMPT_VERSION
        };
    }

    /* ================= 生成（取消 / 迟到响应） ================= */

    var runtime = { counter: 0, active: null };

    function makeController(externalSignal) {
        var controller = null;
        if (typeof AbortController === 'function') controller = new AbortController();
        var aborted = false;
        function fire() { aborted = true; }
        if (externalSignal) {
            if (externalSignal.aborted) fire();
            else if (typeof externalSignal.addEventListener === 'function') {
                externalSignal.addEventListener('abort', fire);
            }
        }
        return {
            signal: controller ? controller.signal : null,
            isAborted: function () {
                if (aborted) return true;
                if (controller && controller.signal && controller.signal.aborted) return true;
                return !!(externalSignal && externalSignal.aborted);
            },
            abort: function () {
                fire();
                if (controller) { try { controller.abort(); } catch (error) { /* 已中止 */ } }
            }
        };
    }

    async function generate(options) {
        options = options || {};
        var aiCall = resolveAiCall(options.aiCall);
        var level = findLevel(options.levelKey);
        if (!level) {
            return { ok: false, reason: 'bad-level', errors: ['未知的等级：' + str(options.levelKey)] };
        }
        var candidates = Array.isArray(options.candidates) ? options.candidates.filter(function (item) {
            return item && trimmed(item.spelling);
        }) : [];
        if (!candidates.length) {
            return { ok: false, reason: 'no-candidates', errors: ['没有可用于出题的目标词'] };
        }
        /* 主题：显式传了就用；没传就按本篇目标词轮换，避免每一篇都是"校园"。
         * 用词的拼写做稳定散列——同一组词必得同一主题（可复现），
         * 换一组词就会换主题（有变化）。 */
        var theme;
        if (THEMES.indexOf(options.theme) >= 0) {
            theme = options.theme;
        } else {
            var seedText = (options.candidates || []).filter(Boolean).map(function (item) {
                return trimmed(item.spelling).toLowerCase();
            }).sort().join('|');
            var seed = 0;
            for (var si = 0; si < seedText.length; si += 1) {
                seed = (seed * 31 + seedText.charCodeAt(si)) % 1000003;
            }
            theme = THEMES[seed % THEMES.length];
        }
        var targetWords = toInt(options.targetWords, level.targetWords);
        if (targetWords < level.allowed[0] || targetWords > level.allowed[1]) targetWords = level.targetWords;

        /* 新任务立刻作废旧任务：旧任务的迟到响应既不能覆盖新结果，也不能继续跑第二遍 AI。 */
        runtime.counter += 1;
        var generation = runtime.counter;
        var requestId = 'req-' + generation + '-' + Date.now().toString(36);
        if (runtime.active && typeof runtime.active.abort === 'function') runtime.active.abort();
        var control = makeController(options.signal);
        runtime.active = control;

        function isCurrent() { return generation === runtime.counter && !control.isAborted(); }
        function finish() { if (runtime.active === control) runtime.active = null; }
        function progress(stage, detail) {
            if (typeof options.onProgress !== 'function') return;
            try { options.onProgress(stage, detail || {}); } catch (error) { /* 回调异常不影响主流程 */ }
        }
        function lateReason() { return generation === runtime.counter ? 'cancelled' : 'superseded'; }

        /* 目标词最多取 60 个：太多会稀释提示词里每条要求的权重。 */
        var words = candidates.slice(0, 60).map(function (item) {
            return { vocId: trimmed(item.vocId), spelling: trimmed(item.spelling) };
        });

        progress('prompt', { requestId: requestId, wordCount: words.length });
        var prompt = buildGenerationPrompt({ level: level, words: words, theme: theme, targetWords: targetWords });
        var request = {
            purpose: 'generate',
            promptVersion: PROMPT_VERSION,
            messages: [
                { role: 'system', content: '你是四六级阅读命题专家，只输出严格 JSON，不写任何解释文字。' },
                { role: 'user', content: prompt }
            ],
            temperature: 0.8,
            responseFormat: true,
            signal: control.signal
        };

        var aiResult;
        try {
            progress('generating', { requestId: requestId });
            aiResult = await callAi(aiCall, request);
        } catch (error) {
            finish();
            if (!isCurrent() || (error && (error.name === 'AbortError' || error.code === 'aborted'))) {
                return { ok: false, reason: lateReason(), requestId: requestId };
            }
            return {
                ok: false, reason: 'ai-error', requestId: requestId,
                errors: ['AI 调用失败：' + (error && error.message ? error.message : String(error))]
            };
        }
        /* 迟到响应：直接丢弃，不写任何状态。 */
        if (!isCurrent()) {
            finish();
            return { ok: false, reason: lateReason(), requestId: requestId };
        }

        var parsed = extractJson(aiResult.content);
        if (!parsed.ok) {
            finish();
            return { ok: false, reason: parsed.reason, requestId: requestId, errors: [parsed.message] };
        }

        var practice = normalizePractice(parsed.value, {
            level: level,
            theme: theme,
            candidates: candidates,
            source: options.source || {},
            accountScope: options.accountScope || 'anonymous',
            provider: aiResult.provider,
            model: aiResult.model,
            requestId: requestId
        });

        progress('validating', { requestId: requestId });
        var checked = validate(practice);
        if (!checked.ok) {
            finish();
            return {
                ok: false, reason: 'invalid-practice', requestId: requestId,
                errors: checked.errors, warnings: checked.warnings, practice: practice
            };
        }

        progress('reviewing', { requestId: requestId });
        var review = await reviewSemantics(practice, { aiCall: aiCall, signal: control.signal });
        if (!isCurrent()) {
            finish();
            return { ok: false, reason: lateReason(), requestId: requestId };
        }
        finish();

        practice.generation.reviewedAt = review.reviewedAt || nowIso();
        practice.generation.reviewNotes = review.notes || '';
        practice.generation.reviewed = review.ok === true;
        practice.generation.reviewOverall = review.overall || '';
        practice.generation.reviewProblems = review.problems || [];
        practice.generation.reviewPerQuestion = review.perQuestion || [];
        practice.generation.reviewPromptVersion = REVIEW_PROMPT_VERSION;

        if (!review.ok) {
            return {
                ok: false, reason: 'review-failed', requestId: requestId,
                errors: review.problems && review.problems.length ? review.problems : [review.notes || '审题未通过'],
                practice: practice, review: review, warnings: checked.warnings
            };
        }
        progress('done', { requestId: requestId });
        return { ok: true, practice: practice, review: review, warnings: checked.warnings, requestId: requestId };
    }

    function cancel() {
        if (runtime.active && typeof runtime.active.abort === 'function') {
            runtime.active.abort();
            runtime.active = null;
            runtime.counter += 1;
            return true;
        }
        return false;
    }

    function isGenerating() { return !!runtime.active; }

    /* ================= 判分（确定性，冻结答案） ================= */

    function frozenAnswerMap(practice) {
        var map = Object.create(null);
        if (Array.isArray(practice && practice.frozenAnswers)) {
            practice.frozenAnswers.forEach(function (entry) {
                if (entry && entry.id) map[trimmed(entry.id)] = trimmed(entry.answer).toUpperCase();
            });
        }
        /* 兼容没有 frozenAnswers 的历史数据：用 questions[i].answer 现场冻结一份，
         * 依然不问 AI、依然确定性。 */
        var questions = practice && Array.isArray(practice.questions) ? practice.questions : [];
        questions.forEach(function (question) {
            if (!question) return;
            var id = trimmed(question.id);
            if (id && !map[id]) map[id] = trimmed(question.answer).toUpperCase();
        });
        return map;
    }

    function normalizeAnswers(practice, answers) {
        var map = Object.create(null);
        if (isObject(answers)) {
            Object.keys(answers).forEach(function (key) {
                map[key] = trimmed(answers[key]).toUpperCase().slice(0, 1);
            });
            return map;
        }
        var questions = practice && Array.isArray(practice.questions) ? practice.questions : [];
        if (Array.isArray(answers)) {
            answers.forEach(function (entry, index) {
                if (isObject(entry)) {
                    var id = trimmed(entry.id !== undefined ? entry.id : entry.questionId);
                    if (!id) return;
                    var value = entry.choice !== undefined ? entry.choice
                        : (entry.answer !== undefined ? entry.answer : entry.chosen);
                    map[id] = trimmed(value).toUpperCase().slice(0, 1);
                } else if (typeof entry === 'string' && questions[index]) {
                    map[trimmed(questions[index].id)] = entry.trim().toUpperCase().slice(0, 1);
                }
            });
        }
        return map;
    }

    function grade(practice, answers) {
        var questions = practice && Array.isArray(practice.questions) ? practice.questions : [];
        var frozen = frozenAnswerMap(practice);
        var chosen = normalizeAnswers(practice, answers);
        var perQuestion = [];
        var correct = 0;
        questions.forEach(function (question) {
            if (!question) return;
            var id = trimmed(question.id);
            var answer = chosen[id] || '';
            if (OPTION_KEYS.indexOf(answer) < 0) answer = '';
            var expected = frozen[id] || '';
            var ok = !!answer && answer === expected;
            if (ok) correct += 1;
            perQuestion.push({ id: id, chosen: answer || null, correct: expected || null, ok: ok });
        });
        return { correct: correct, total: questions.length, perQuestion: perQuestion };
    }

    function isSubmittable(practice) {
        var checked = validate(practice);
        if (!checked.ok) return { ok: false, errors: checked.errors, warnings: checked.warnings };
        var generation = practice.generation || {};
        /* reviewed 不能是一个"谁都能置 true"的裸布尔。必须同时满足：
         *   1. reviewed === true；
         *   2. 没有遗留的审题问题（reviewProblems 为空）；
         *   3. reviewedAt 是可解析的时间；
         *   4. 逐题结论数量与题目数一致（覆盖到每一题）。
         * 否则篡改一个布尔值就能把未审题的练习变成可提交。 */
        if (generation.reviewed !== true) {
            return { ok: false, errors: ['这份练习还没有通过独立审题，不能提交'], warnings: checked.warnings };
        }
        var reviewErrors = [];
        if (Array.isArray(generation.reviewProblems) && generation.reviewProblems.length) {
            reviewErrors.push('审题存在未解决的问题：' + generation.reviewProblems.slice(0, 3).join('；'));
        }
        if (!generation.reviewedAt || isNaN(Date.parse(generation.reviewedAt))) {
            reviewErrors.push('缺少可用的审题时间，无法确认这份练习经过独立审题');
        }
        var perQuestion = Array.isArray(generation.reviewPerQuestion) ? generation.reviewPerQuestion : null;
        var questionCount = Array.isArray(practice.questions) ? practice.questions.length : 0;
        if (!perQuestion || perQuestion.length !== questionCount) {
            reviewErrors.push('逐题审题结论数量与题目数不一致');
        }
        if (reviewErrors.length) {
            return { ok: false, errors: reviewErrors, warnings: checked.warnings };
        }
        return { ok: true, errors: [], warnings: checked.warnings };
    }

    /* ================= 存储（按账号隔离） ================= */

    var memoryStore = Object.create(null);

    function defaultStorage() {
        try {
            if (typeof localStorage !== 'undefined' && localStorage &&
                typeof localStorage.getItem === 'function' &&
                typeof localStorage.setItem === 'function') {
                return {
                    getItem: function (key) { return localStorage.getItem(key); },
                    setItem: function (key, value) { localStorage.setItem(key, value); },
                    removeItem: function (key) { localStorage.removeItem(key); }
                };
            }
        } catch (error) { /* 受限 WebView 退到内存 */ }
        return {
            getItem: function (key) { return Object.prototype.hasOwnProperty.call(memoryStore, key) ? memoryStore[key] : null; },
            setItem: function (key, value) { memoryStore[key] = String(value); },
            removeItem: function (key) { delete memoryStore[key]; }
        };
    }

    function resolveStoreDeps(options) {
        var merged = Object.assign({}, injected, options || {});
        return { store: merged.store || null, accountScope: merged.accountScope };
    }

    function storeOf(deps) { return deps.store || defaultStorage(); }

    function scopeKey(scope) {
        return STORE_PREFIX + '::' + encodeURIComponent(str(scope || 'anonymous'));
    }

    function readList(deps, scope, name) {
        var raw = null;
        try { raw = storeOf(deps).getItem(scopeKey(scope) + '::' + name); } catch (error) { return []; }
        if (!raw) return [];
        try {
            var parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (error) { return []; }
    }

    function writeList(deps, scope, name, list) {
        try {
            storeOf(deps).setItem(scopeKey(scope) + '::' + name, JSON.stringify(list));
            return true;
        } catch (error) { return false; }
    }

    function practiceSummary(practice) {
        return {
            id: practice.id,
            title: practice.title,
            level: practice.level,
            levelLabel: practice.levelLabel,
            createdAt: practice.createdAt,
            wordCount: practice.wordCount,
            questionCount: Array.isArray(practice.questions) ? practice.questions.length : 0,
            completeness: practice.source ? practice.source.completeness : '',
            reviewed: !!(practice.generation && practice.generation.reviewed),
            accountScope: practice.accountScope
        };
    }

    /* ================= 服务端存档（归属权威） =================
     * 本地 localStorage 只是缓存：真正的"这份练习属于谁"由服务端判定。
     * 服务端用当前账号派生 profile_id，请求体里的 scope 一律被忽略，
     * 所以换账号读不到别人的练习与成绩。
     *
     * 所有远程调用都是"尽力而为"：网络或服务端不可用时不影响本机作答，
     * 只把失败原因记在返回值的 remote 字段里，由界面决定怎么提示。
     */

    var REMOTE_TIMEOUT_MS = 8000;

    function remoteEnabled(options) {
        var merged = Object.assign({}, injected, options || {});
        if (merged.remote === false) return false;
        if (typeof merged.fetchImpl === 'function') return true;
        return typeof fetch === 'function';
    }

    function remoteFetch(options) {
        var merged = Object.assign({}, injected, options || {});
        return typeof merged.fetchImpl === 'function' ? merged.fetchImpl : fetch;
    }

    function remoteRequest(options, method, path, body) {
        if (!remoteEnabled(options)) {
            return Promise.resolve({ ok: false, reason: 'disabled' });
        }
        var doFetch = remoteFetch(options);
        var controller = null;
        var timer = null;
        var init = {
            method: method,
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest'
            }
        };
        if (body !== undefined) {
            init.headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(body);
        }
        try {
            if (typeof AbortController === 'function') {
                controller = new AbortController();
                init.signal = controller.signal;
                timer = setTimeout(function () { controller.abort(); }, REMOTE_TIMEOUT_MS);
            }
        } catch (error) { controller = null; }

        function done(value) {
            if (timer) { clearTimeout(timer); timer = null; }
            return value;
        }

        var pending;
        try { pending = doFetch(path, init); }
        catch (error) { return Promise.resolve({ ok: false, reason: 'network', message: String(error) }); }

        return Promise.resolve(pending).then(function (response) {
            var status = response && typeof response.status === 'number' ? response.status : 0;
            var parse = typeof response.json === 'function' ? response.json() : Promise.resolve(null);
            return Promise.resolve(parse).then(function (payload) {
                if (status >= 200 && status < 300) {
                    return done({ ok: true, status: status, payload: payload || {} });
                }
                if (status === 401) return done({ ok: false, reason: 'unauthenticated', status: status });
                if (status === 404) return done({ ok: false, reason: 'missing', status: status });
                return done({ ok: false, reason: 'http', status: status,
                              message: (payload && payload.error) || '' });
            }, function () {
                return done({ ok: status >= 200 && status < 300, status: status, reason: 'body' });
            });
        }, function (error) {
            var aborted = !!(error && error.name === 'AbortError');
            return done({ ok: false, reason: aborted ? 'timeout' : 'network', message: String(error) });
        });
    }

    function remoteSave(practice, options) {
        return remoteRequest(options, 'POST', '/api/reading/practices', { practice: practice })
            .then(function (result) { return result; });
    }

    function remoteLoad(practiceId, options) {
        return remoteRequest(options, 'GET',
            '/api/reading/practices/' + encodeURIComponent(String(practiceId || '')))
            .then(function (result) {
                if (result.ok && result.payload && result.payload.practice) {
                    return { ok: true, practice: result.payload.practice };
                }
                return result;
            });
    }

    function remoteList(options) {
        return remoteRequest(options, 'GET', '/api/reading/practices').then(function (result) {
            if (result.ok && result.payload && Array.isArray(result.payload.practices)) {
                return { ok: true, practices: result.payload.practices };
            }
            return result;
        });
    }

    function remoteSaveAttempt(attempt, options) {
        return remoteRequest(options, 'POST', '/api/reading/attempts', { attempt: attempt });
    }

    /* 服务端权威读取。与同步的 load/listDrafts 不同，这两个函数等待服务端结果：
     * 服务端按当前账号派生 profile_id，因此换账号后不可能拿到上一位用户的练习。 */
    function listDraftsRemote(options) {
        return remoteList(options).then(function (result) {
            if (!result.ok || !result.practices) {
                return { ok: false, drafts: [], reason: result.reason || 'remote-unavailable' };
            }
            return { ok: true, drafts: result.practices, remote: true };
        });
    }

    function loadRemote(id, options) {
        return remoteLoad(id, options).then(function (result) {
            if (!result.ok || !result.practice) {
                return { ok: false, practice: null, reason: result.reason || 'remote-unavailable' };
            }
            var item = result.practice;
            var scope = (options && options.accountScope) || 'anonymous';
            if (item.accountScope && item.accountScope !== scope) {
                return { ok: false, practice: null, reason: 'scope-mismatch' };
            }
            return { ok: true, practice: item, remote: true };
        });
    }

    function save(practice, options) {
        var checked = validate(practice);
        if (!checked.ok) {
            return { ok: false, errors: checked.errors, message: '练习未通过结构校验，不能保存' };
        }
        var deps = resolveStoreDeps(options);
        var scope = practice.accountScope || deps.accountScope || 'anonymous';
        if (deps.accountScope && practice.accountScope && deps.accountScope !== practice.accountScope) {
            return { ok: false, errors: ['账号不一致，拒绝保存'], message: '账号已切换' };
        }
        var drafts = readList(deps, scope, 'drafts');
        var next = drafts.filter(function (item) { return item && item.id !== practice.id; });
        next.unshift(practice);
        var written = writeList(deps, scope, 'drafts', next.slice(0, 50));
        // 服务端存档：归属由服务端按当前账号派生，客户端 scope 会被忽略。
        // 异步进行，不阻断本机作答；失败只记在返回值里供界面提示。
        if (written && remoteEnabled(options) && scope !== 'anonymous') {
            remoteSave(practice, options).catch(function () { return null; });
        }
        return { ok: written, id: practice.id, accountScope: scope, warnings: checked.warnings };
    }

    function load(id, options) {
        var deps = resolveStoreDeps(options);
        var scope = deps.accountScope || 'anonymous';
        var drafts = readList(deps, scope, 'drafts');
        for (var i = 0; i < drafts.length; i += 1) {
            var item = drafts[i];
            if (!item || item.id !== id) continue;
            /* 账号隔离：即便存储被串号，也不返回别的账号的练习。 */
            if (item.accountScope && item.accountScope !== scope) return null;
            return item;
        }
        return null;
    }

    function listDrafts(options) {
        var deps = resolveStoreDeps(options);
        var scope = deps.accountScope || 'anonymous';
        return readList(deps, scope, 'drafts').filter(function (item) {
            return item && (!item.accountScope || item.accountScope === scope);
        });
    }

    function submit(practice, answers, options) {
        var checked = isSubmittable(practice);
        if (!checked.ok) {
            return { ok: false, errors: checked.errors, message: '这份练习未通过校验/审题，不能提交' };
        }
        var deps = resolveStoreDeps(options);
        var scope = deps.accountScope || practice.accountScope || 'anonymous';
        if (practice.accountScope && practice.accountScope !== scope) {
            return { ok: false, errors: ['账号不一致，拒绝提交'], message: '账号已切换' };
        }
        var attempts = readList(deps, scope, 'attempts');

        /* 防重复提交 vs 重做，是两个相反的要求：
         *   · 连点两次「提交」不能算两遍分 → 必须去重；
         *   · 「重做本文」是另一次作答 → 必须另记一条，绝不能返回旧分数。
         * 靠 attemptKey 区分：调用方每开始一次作答就生成一个新的 key，
         * 同一个 key 重复提交只会落一条记录。没有 key 时退回按 practiceId 去重，
         * 保持对旧调用的兼容（那种情况下"重复"就是连点）。 */
        var attemptKey = trimmed(options && options.attemptKey);
        for (var i = 0; i < attempts.length; i += 1) {
            var prev = attempts[i];
            if (!prev || prev.practiceId !== practice.id) continue;
            var sameSession = attemptKey
                ? trimmed(prev.attemptKey) === attemptKey
                : true;
            if (sameSession) {
                return { ok: true, duplicate: true, attempt: prev, accountScope: scope, result: prev.result };
            }
        }
        var result = grade(practice, answers);
        var record = {
            id: makeId('attempt'),
            practiceId: practice.id,
            attemptKey: attemptKey || '',
            title: practice.title,
            level: practice.level,
            levelLabel: practice.levelLabel,
            submittedAt: nowIso(),
            answers: normalizeAnswers(practice, answers),
            result: result,
            accountScope: scope,
            note: '阅读正确率不等于单词掌握率，也不是四六级分数换算。'
        };
        attempts.unshift(record);
        var written = writeList(deps, scope, 'attempts', attempts.slice(0, 200));
        // 服务端判分记录：服务端按当前账号派生归属，并对 attemptKey 去重。
        if (written && remoteEnabled(options) && scope !== 'anonymous') {
            remoteSaveAttempt(record, options).catch(function () { return null; });
        }
        return { ok: written, attempt: record, accountScope: scope, result: result };
    }

    function listAttempts(options) {
        var deps = resolveStoreDeps(options);
        var scope = deps.accountScope || 'anonymous';
        return readList(deps, scope, 'attempts').filter(function (item) {
            return item && (!item.accountScope || item.accountScope === scope);
        });
    }

    function remove(id, options) {
        var deps = resolveStoreDeps(options);
        var scope = deps.accountScope || 'anonymous';
        var drafts = readList(deps, scope, 'drafts');
        var next = drafts.filter(function (item) { return !item || item.id !== id; });
        return { ok: writeList(deps, scope, 'drafts', next), removed: drafts.length - next.length };
    }

    function clearAccount(scope, options) {
        var deps = resolveStoreDeps(options);
        var target = scope || deps.accountScope || 'anonymous';
        writeList(deps, target, 'drafts', []);
        writeList(deps, target, 'attempts', []);
        return { ok: true, accountScope: target };
    }

    return {
        VERSION: VERSION,
        SCHEMA: SCHEMA,
        PROMPT_VERSION: PROMPT_VERSION,
        REVIEW_PROMPT_VERSION: REVIEW_PROMPT_VERSION,
        LEVELS: LEVELS,
        THEMES: THEMES,
        QUESTION_TYPES: QUESTION_TYPES,
        QUESTION_COUNT: QUESTION_COUNT,
        OPTION_KEYS: OPTION_KEYS,
        MIN_QUOTE_TOKENS: MIN_QUOTE_TOKENS,

        generate: generate,
        cancel: cancel,
        isGenerating: isGenerating,
        validate: validate,
        reviewSemantics: reviewSemantics,
        grade: grade,
        isSubmittable: isSubmittable,
        buildGenerationPrompt: buildGenerationPrompt,
        buildReviewPrompt: buildReviewPrompt,
        setDeps: setDeps,
        resetDeps: resetDeps,

        save: save,
        load: load,
        listDrafts: listDrafts,
        submit: submit,
        // 服务端权威读取：UI 用它校正本地缓存，确保换账号读不到别人的练习。
        listDraftsRemote: listDraftsRemote,
        loadRemote: loadRemote,
        listAttempts: listAttempts,
        remove: remove,
        clearAccount: clearAccount,
        summary: practiceSummary,

        normalizePractice: normalizePractice,
        extractJson: extractJson,
        tokenize: tokenize,
        containsTokens: containsTokens,
        countEnglishWords: countEnglishWords,
        practiceWordCount: practiceWordCount,
        findSurfaceOffset: findSurfaceOffset,
        frozenAnswerMap: frozenAnswerMap,
        defaultAiCall: defaultAiCall
    };
});
