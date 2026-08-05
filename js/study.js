// ==========================================
// Memo Superform - 背单词自测模式
// 在电脑上复习今日单词，支持AI翻译释义
// ==========================================

const StudyMode = (function() {
    let overlay = null;
    let items = [];          // 今日单词列表
    let definitions = {};    // 单词释义缓存
    let currentIndex = 0;
    let isFlipped = false;
    let isShuffled = false;
    let filterMode = 'all';  // all | unfinished | new
    let sessionResults = {}; // {spelling: 'know'|'vague'|'forget'}
    let sessionDate = '';

    // ---- DOM 引用 ----
    let elWord, elPhonetic, elTrans, elExample, elExampleLabel, elTagRow;
    let elCard, elProgressText, elProgressBar, elActions, elMain;
    let elLoading, elEmpty, elSummary;

    function init() {
        const btn = document.getElementById('studyBtn');
        if (btn) btn.addEventListener('click', open);
        overlay = document.getElementById('studyOverlay');
        if (!overlay) return;
        elCard = overlay.querySelector('.flashcard');
        elWord = overlay.querySelector('.card-word');
        elPhonetic = overlay.querySelector('.card-phonetic');
        elTagRow = overlay.querySelector('.card-tag-row');
        elTrans = overlay.querySelector('.card-trans');
        elExample = overlay.querySelector('.card-example');
        elExampleLabel = overlay.querySelector('.card-example-label');
        elProgressText = overlay.querySelector('.study-progress-text');
        elProgressBar = overlay.querySelector('.study-progress-bar');
        elActions = overlay.querySelector('.study-actions');
        elMain = overlay.querySelector('.study-main');
        elLoading = overlay.querySelector('.study-loading');
        elEmpty = overlay.querySelector('.study-empty');
        elSummary = overlay.querySelector('.study-summary');

        overlay.querySelector('.study-close-btn').addEventListener('click', close);
        overlay.querySelector('.flashcard-wrap').addEventListener('click', flipCard);

        overlay.querySelectorAll('.mark-btn').forEach(function(btn) {
            btn.addEventListener('click', function() { markWord(btn.dataset.mark); });
        });

        const filterSel = overlay.querySelector('.study-filter-select');
        if (filterSel) filterSel.addEventListener('change', function() {
            filterMode = this.value;
            restartSession();
        });

        const shuffleBtn = overlay.querySelector('.study-shuffle-btn');
        if (shuffleBtn) shuffleBtn.addEventListener('click', function() {
            isShuffled = !isShuffled;
            this.classList.toggle('active', isShuffled);
            restartSession();
        });

        const restartBtn = overlay.querySelector('.summary-restart');
        if (restartBtn) restartBtn.addEventListener('click', restartSession);

        const doneBtn = overlay.querySelector('.summary-done');
        if (doneBtn) doneBtn.addEventListener('click', close);

        // 键盘快捷键
        document.addEventListener('keydown', function(e) {
            if (!overlay || !overlay.classList.contains('active')) return;
            if (e.key === 'Escape') { close(); return; }
            if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flipCard(); return; }
            if (!isFlipped) return;
            if (e.key === '1') markWord('forget');
            else if (e.key === '2') markWord('vague');
            else if (e.key === '3') markWord('know');
            else if (e.key === 'ArrowLeft') markWord('forget');
            else if (e.key === 'ArrowUp') markWord('vague');
            else if (e.key === 'ArrowRight') markWord('know');
        });
    }

    async function open() {
        if (!MaimemoAPI.hasToken()) {
            alert('请先在设置中配置墨墨 API Token');
            return;
        }
        overlay.classList.add('active');
        showLoading('正在获取今日单词...');
        sessionDate = new Date().toLocaleDateString('zh-CN').replace(/\//g, '-');
        sessionResults = {};
        currentIndex = 0;
        isFlipped = false;

        try {
            const data = await MaimemoAPI.getTodayItems({ limit: 1000 }, false);
            items = (data.today_items || []).slice().sort(function(a, b) {
                return (a.order || 0) - (b.order || 0);
            });

            if (items.length === 0) {
                showEmpty();
                return;
            }

            showLoading('正在获取单词释义...');
            const spellings = items.map(function(i) { return i.voc_spelling; });
            definitions = await fetchDefinitions(spellings);

            startSession();
        } catch (e) {
            showLoading('获取失败: ' + e.message);
            setTimeout(function() { showEmpty(); }, 2000);
        }
    }

    function close() {
        overlay.classList.remove('active');
        // 重置卡片
        if (elCard) elCard.classList.remove('flipped');
        isFlipped = false;
    }

    // ---- 获取释义（AI优先，Free Dictionary API兜底）----
    async function fetchDefinitions(spellings) {
        var result = {};
        // 先走AI批量翻译
        try {
            result = await AIAPI.getWordDefinitions(spellings);
        } catch (e) {
            console.warn('AI翻译失败:', e);
        }

        // 找出还没有释义的单词，用Free Dictionary API兜底
        var missing = spellings.filter(function(w) { return !result[w]; });
        if (missing.length > 0 && missing.length <= 50) {
            var promises = missing.map(function(w) {
                return fetchFreeDict(w).then(function(def) {
                    if (def) result[w] = def;
                }).catch(function() {});
            });
            await Promise.all(promises);
        }

        return result;
    }

    async function fetchFreeDict(word) {
        var cacheKey = 'memo_wdef_' + word.toLowerCase();
        var cached = localStorage.getItem(cacheKey);
        if (cached) {
            try { return JSON.parse(cached); } catch(e) {}
        }
        try {
            var resp = await fetch('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(word));
            if (!resp.ok) return null;
            var data = await resp.json();
            if (!data || !data[0]) return null;
            var entry = data[0];
            var phonetic = entry.phonetic || '';
            if (!phonetic && entry.phonetics) {
                for (var i = 0; i < entry.phonetics.length; i++) {
                    if (entry.phonetics[i].text) { phonetic = entry.phonetics[i].text; break; }
                }
            }
            var meanings = entry.meanings || [];
            var transParts = [];
            var example = '';
            for (var m = 0; m < meanings.length && m < 3; m++) {
                var meaning = meanings[m];
                var pos = meaning.partOfSpeech || '';
                var defs = meaning.definitions || [];
                if (defs.length > 0) {
                    var d = defs[0].definition || '';
                    transParts.push((pos ? pos + '. ' : '') + d);
                    if (!example && defs[0].example) example = defs[0].example;
                }
            }
            var def = {
                trans: transParts.join('; ') || '(无释义)',
                phonetic: phonetic || '',
                example: example || ''
            };
            localStorage.setItem(cacheKey, JSON.stringify(def));
            return def;
        } catch (e) {
            return null;
        }
    }

    // ---- 会话管理 ----
    function getFilteredItems() {
        var filtered = items;
        if (filterMode === 'unfinished') {
            filtered = items.filter(function(i) { return !i.is_finished; });
        } else if (filterMode === 'new') {
            filtered = items.filter(function(i) { return i.is_new; });
        }
        if (isShuffled) {
            filtered = filtered.slice();
            for (var i = filtered.length - 1; i > 0; i--) {
                var j = Math.floor(Math.random() * (i + 1));
                var tmp = filtered[i]; filtered[i] = filtered[j]; filtered[j] = tmp;
            }
        }
        return filtered;
    }

    var sessionItems = [];

    function startSession() {
        sessionItems = getFilteredItems();
        currentIndex = 0;
        sessionResults = {};
        if (sessionItems.length === 0) {
            showEmpty();
            return;
        }
        elLoading.style.display = 'none';
        elEmpty.style.display = 'none';
        elSummary.style.display = 'none';
        elMain.querySelector('.flashcard-wrap').style.display = 'block';
        elActions.style.display = 'flex';
        renderCard();
    }

    function restartSession() {
        currentIndex = 0;
        sessionResults = {};
        isFlipped = false;
        if (elCard) elCard.classList.remove('flipped');
        startSession();
    }

    function renderCard() {
        if (currentIndex >= sessionItems.length) {
            showSummary();
            return;
        }
        var item = sessionItems[currentIndex];
        var def = definitions[item.voc_spelling] || {};

        // 正面
        elWord.textContent = item.voc_spelling;
        elPhonetic.textContent = def.phonetic || '';

        // 标签
        elTagRow.innerHTML = '';
        if (item.is_new) {
            elTagRow.innerHTML += '<span class="card-tag new">新学</span>';
        }
        if (item.is_finished) {
            elTagRow.innerHTML += '<span class="card-tag finished">已完成</span>';
        } else {
            elTagRow.innerHTML += '<span class="card-tag unfinished">未完成</span>';
        }

        // 背面
        elTrans.textContent = def.trans || '(暂无释义，请配置AI API Key获取翻译)';
        if (def.example) {
            elExampleLabel.style.display = 'block';
            elExample.textContent = def.example;
            elExample.style.display = 'block';
        } else {
            elExampleLabel.style.display = 'none';
            elExample.style.display = 'none';
        }

        // 重置翻转状态
        isFlipped = false;
        elCard.classList.remove('flipped');
        updateActions();
        updateProgress();
    }

    function flipCard() {
        if (currentIndex >= sessionItems.length) return;
        isFlipped = !isFlipped;
        elCard.classList.toggle('flipped', isFlipped);
        updateActions();
    }

    function updateActions() {
        var btns = elActions.querySelectorAll('.mark-btn');
        btns.forEach(function(btn) { btn.disabled = !isFlipped; });
    }

    function updateProgress() {
        var total = sessionItems.length;
        var cur = currentIndex + 1;
        elProgressText.textContent = cur + ' / ' + total;
        elProgressBar.style.width = (total > 0 ? (cur / total * 100) : 0) + '%';
    }

    function markWord(mark) {
        if (!isFlipped || currentIndex >= sessionItems.length) return;
        var item = sessionItems[currentIndex];
        sessionResults[item.voc_spelling] = mark;

        // 保存到localStorage
        try {
            var key = 'memo_selftest_' + sessionDate;
            var saved = JSON.parse(localStorage.getItem(key) || '{}');
            saved[item.voc_spelling] = mark;
            localStorage.setItem(key, JSON.stringify(saved));
        } catch(e) {}

        currentIndex++;
        // 添加退出动画
        elCard.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        elCard.style.opacity = '0';
        elCard.style.transform = isFlipped ? 'rotateY(180deg) translateX(-30px)' : 'translateX(-30px)';

        setTimeout(function() {
            elCard.style.transition = '';
            elCard.style.opacity = '';
            elCard.style.transform = '';
            renderCard();
            // 入场动画
            elCard.style.opacity = '0';
            elCard.style.transform = 'translateX(30px)';
            requestAnimationFrame(function() {
                elCard.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
                elCard.style.opacity = '1';
                elCard.style.transform = '';
                setTimeout(function() { elCard.style.transition = ''; }, 300);
            });
        }, 200);
    }

    function showSummary() {
        elMain.querySelector('.flashcard-wrap').style.display = 'none';
        elActions.style.display = 'none';
        elLoading.style.display = 'none';
        elEmpty.style.display = 'none';
        elSummary.style.display = 'block';

        var know = 0, vague = 0, forget = 0;
        for (var k in sessionResults) {
            if (sessionResults[k] === 'know') know++;
            else if (sessionResults[k] === 'vague') vague++;
            else if (sessionResults[k] === 'forget') forget++;
        }
        elSummary.querySelector('.stat-know').textContent = know;
        elSummary.querySelector('.stat-vague').textContent = vague;
        elSummary.querySelector('.stat-forget').textContent = forget;
        elSummary.querySelector('.summary-total').textContent = sessionItems.length;

        var icon = know >= forget ? '🎉' : '💪';
        elSummary.querySelector('.summary-icon').textContent = icon;
    }

    function showLoading(msg) {
        elLoading.style.display = 'block';
        elLoading.querySelector('p').textContent = msg;
        elEmpty.style.display = 'none';
        elSummary.style.display = 'none';
        elMain.querySelector('.flashcard-wrap').style.display = 'none';
        elActions.style.display = 'none';
    }

    function showEmpty() {
        elLoading.style.display = 'none';
        elSummary.style.display = 'none';
        elMain.querySelector('.flashcard-wrap').style.display = 'none';
        elActions.style.display = 'none';
        elEmpty.style.display = 'block';
    }

    return { init: init };
})();