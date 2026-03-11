/**
 * GeoChat Questions v3
 * ══════════════════════════════════════════════════════
 *
 * კითხვების დასამატებლად გადადი ქვემოთ:
 * ┌─────────────────────────────────────────────────────
 * │  ▼▼▼  კითხვების სია — აქ დაამატე/შეცვალე  ▼▼▼
 * └─────────────────────────────────────────────────────
 * ფორმატი: { id: N, emoji: '😊', text: 'კითხვის ტექსტი?' }
 * id უნდა იყოს უნიკალური რიცხვი!
 *
 * ══════════════════════════════════════════════════════
 */
const Questions = (() => {

    /* ══════════════════════════════════════════════════
     * ▼▼▼  კითხვების სია — აქ დაამატე/შეცვალე  ▼▼▼
     * ══════════════════════════════════════════════════ */
    const QUESTIONS = [
        // ── რომანტიკული / ურთიერთობები ──────────────────────────
        { id: 1,  emoji: '💘',   text: 'შენი ყველაზე კარგი პირველი შეხვედრა რა იყო?' },
        { id: 2,  emoji: '🤫',   text: 'ოდესმე გიყვარდა ვინმე, ვისაც ვერ ეუბნებოდი?' },
        { id: 3,  emoji: '❤️',   text: 'რომელი ასაკი გიყვარს ურთიერთობაში — უმცროსი, ტოლი, თუ უფროსი?' },
        { id: 4,  emoji: '🚩',   text: 'შენი "წითელი ხაზი" ურთიერთობაში რა არის?' },
        { id: 5,  emoji: '🥺',   text: 'ოდესმე გიცდია ყველაფრის დათმობა სიყვარულის გამო?' },
        { id: 6,  emoji: '💌',   text: 'ოდენ ბოლოს გაგიგზავნია ვინმეს "პირველი ნაბიჯი"?' },
        { id: 7,  emoji: '💔',   text: 'Situationship გქონდა ოდესმე? როგორ დამთავრდა?' },
        { id: 8,  emoji: '🫀',   text: 'ოდენ იგრძნობ, რომ ვინმე "შენია" — პირველი დღიდანვე?' },
        { id: 9,  emoji: '📵',   text: 'ოდესმე ვინმეს "ბლოკი" დაუდე, მოგვიანებით კი — მოხსენი?' },
        { id: 10, emoji: '🌙',   text: 'რა ჩვევა ან ხასიათი ყველაზე ძნელი მისაღებია პარტნიორში?' },

        // ── გართობა / სახალისო ──────────────────────────────────
        { id: 11, emoji: '👻',   text: 'ოდესმე გიკეთებია "ghosting"? ან — შენ გამოგიკეთებიათ?' },
        { id: 12, emoji: '🎵',   text: 'Spotify-ზე ყველაზე შემრცხვენელი სიმღერა რომელია?' },
        { id: 13, emoji: '📱',   text: 'ბოლო 3 emoji რომელი გამოიყენე?' },
        { id: 14, emoji: '🔐',   text: 'ოდესმე გამოიყენე ვინმეს პაროლი ნებართვის გარეშე?' },
        { id: 15, emoji: '🎭',   text: 'რომელ სოციალ მედიაზე ყველაზე სხვა ადამიანი ხარ?' },
        { id: 16, emoji: '📲',   text: 'ინსტაგრამზე ვინ გყავს Close Friends-ში — და რატომ?' },
        { id: 17, emoji: '🤥',   text: 'ბოლოს რა "თეთრი სიცრუე" გითქვამს?' },
        { id: 18, emoji: '😳',   text: 'ოდენ გამოგიგზავნია შეტყობინება არასწორ ადამიანს?' },

        // ── Would You Rather ─────────────────────────────────────
        { id: 19, emoji: '☀️❄️', text: 'ავარჩიე: მარად ზამთარი — თუ მარად ზაფხული?' },
        { id: 20, emoji: '🧠',   text: 'ავარჩიე: ყველამ იცოდეს შენი ყველა ფიქრი — თუ შენ ყველა სხვისი?' },
        { id: 21, emoji: '👥',   text: 'ავარჩიე: ერთი ნამდვილი მეგობარი — თუ 100 სასიამოვნო ნაცნობი?' },
        { id: 22, emoji: '🗣️',  text: 'ავარჩიე: ყოველთვის ბოლო სიტყვა გქონდეს — თუ ყოველთვის კამათში გაიმარჯვო?' },
        { id: 23, emoji: '⏳',   text: 'ავარჩიე: 10 წელი + ყველა ოცნება — თუ 60 წელი + ჩვეული ცხოვრება?' },
        { id: 24, emoji: '💰',   text: 'ავარჩიე: ბევრი ფული & მარტოობა — თუ ცოტა ფული & ბედნიერი ურთიერთობა?' },
        { id: 25, emoji: '🕵️',  text: 'ავარჩიე: ყველა შენი საიდუმლო გახმაურდეს — თუ ერთი ყველაზე დიდი?' },
        { id: 26, emoji: '🔄',   text: 'ავარჩიე: წარსულში ერთი გადაწყვეტილება შეცვალო — თუ მომავალი 1 წელი წინ ნახო?' },
        { id: 27, emoji: '📞',   text: 'ავარჩიე: ყველა ზარი ყოველთვის პასუხობდე — თუ ყველა შეტყობინება ყოველთვის წაიკითხო?' },

        // ── Never Have I Ever ─────────────────────────────────────
        { id: 28, emoji: '🌊',   text: '"Never Have I Ever" — ზღვაში ღამით ბანაობა?' },
        { id: 29, emoji: '😭',   text: '"Never Have I Ever" — შუაღამით ამიტირებია ყოველგვარი მიზეზის გარეშე?' },
        { id: 30, emoji: '💞',   text: '"Never Have I Ever" — მიყვარდა ჩემი მეგობრის შეყვარებული?' },
        { id: 31, emoji: '👁️',  text: '"Never Have I Ever" — "seen zone" შეგნებულად გამიკეთებია?' },
        { id: 32, emoji: '🎭',   text: '"Never Have I Ever" — ვინმეს ვუთამაშე, სინამდვილეში კი — მომწონდა?' },
        { id: 33, emoji: '🌃',   text: '"Never Have I Ever" — მთელი ღამე ვინმესთან ვლაპარაკობდი და დილა ვერ შევამჩნიე?' },
        { id: 34, emoji: '📸',   text: '"Never Have I Ever" — ვინმეს პროფილი ანონიმურად გადავხედე?' },

        // ── სიღრმე / ინტიმური ────────────────────────────────────
        { id: 35, emoji: '🪞',   text: 'ვის გვერდით ხარ ყველაზე "შენი თავი"?' },
        { id: 36, emoji: '🌑',   text: 'მარტოობა შეგეშინდება — თუ ვის გვერდითაც ხარ, ისევ მარტო?' },
        { id: 37, emoji: '💬',   text: 'ბოლოს ვინ ეჩვენა გულით, ვინ კი — მხოლოდ სახეზე?' },
        { id: 38, emoji: '🌫️',  text: '"ყველა კარგია" — ოდენ ამბობ ამას, სინამდვილეში კი — ყველაფერი ირყევა?' },
        { id: 39, emoji: '📨',   text: 'ყველაზე გრძელი "ახსნა" ვის გაუგზავნე? მივიდა?' },
        { id: 40, emoji: '🕯️',  text: 'ვინ არის ის ადამიანი, ვისთანაც დახმარება ყველაზე ძნელად გეთხოვება?' },

        // ── ახალი კითხვები ────────────────────────────────────────
        { id: 41, emoji: '🔥',   text: 'რა არის რაც გინდა ცადო ურთიერთობაში, რომელიც მანამდე არ გიცდია?' },
        { id: 42, emoji: '😏',   text: 'ოდესმე გიფლირტავია ვინმესთან, რომ შენთვის რამე შეესრულებინა?' },
        { id: 43, emoji: '😘💍🔪', text: 'ვის აკოცებდი, ვიზე დაქორწინდებოდი და ვის მოკლავდი ამ ოთახში?' },
        { id: 44, emoji: '💀',   text: 'ამ ოთახში ვინ დარჩება სამუდამოდ მარტოხელა?' },
        { id: 45, emoji: '💒',   text: 'ამ ოთახში ვინ დაქორწინდება პირველი?' },
        { id: 46, emoji: '🌪️❤️', text: 'რომელ ურთიერთობას ანიჭებ უპირატესობას — ველურ, ვნებიანს, თუ მშვიდ, წყნარს?' },
        { id: 47, emoji: '🌹',   text: 'რა იყო შენი საუკეთესო პაემნის გამოცდილება?' },
        { id: 48, emoji: '🤦',   text: 'რა იყო შენი ყველაზე უცნაური პაემანი?' },
        { id: 49, emoji: '🍾',   text: 'რა არის ყველაზე მეტი, რაც ერთ ღამეში დაგილევია?' },
        { id: 50, emoji: '✏️',   text: 'არის თუ არა რამე, რასაც შენს პარტნიორში შეცვლიდი?' },
        { id: 51, emoji: '💎',   text: 'რა არის ერთი თვისება, რომელიც შენს პარტნიორს აუცილებლად უნდა ჰქონდეს?' },
        { id: 52, emoji: '🤥',   text: 'რა არის ყველაზე ცუდი ტყუილი, რაც ოდესმე გითქვამს შენი პარტნიორისთვის?' },
        { id: 53, emoji: '😰',   text: 'რა არის შენი ყველაზე დიდი შიში ურთიერთობაში?' },
        { id: 54, emoji: '💤',   text: 'ოდესმე დაგსიზმრებია შენი პარტნიორი? რაზე იყო სიზმარი?' },
        { id: 55, emoji: '🔧',   text: 'რომ შეგეძლოს ერთი რამის შეცვლა შენს ურთიერთობაში, რას შეცვლიდი?' },
        { id: 56, emoji: '🥰',   text: 'რა არის შენი ყველაზე საყვარელი რამ შენს პარტნიორში?' },
        { id: 57, emoji: '🙏',   text: 'ერთი რამ, რასაც ოცნებობ შენი პარტნიორი უფრო ხშირად აკეთებდეს?' },
        { id: 58, emoji: '🌅',   text: 'მთელი დღე პარტნიორთან ერთად რომ გაატარო — რას გააკეთებდი?' },
        { id: 59, emoji: '🚫',   text: 'არის რამე, რასაც პარტნიორს არასდროს არ აპატიებდი? რა არის ეს?' },
        { id: 60, emoji: '🤝',   text: 'ენდობი შენს პარტნიორს, რომ შენი ერთგული იყოს სამუდამოდ?' },
    ];
        // ── ▲▲▲  კითხვების სია დასრულდა  ▲▲▲ ─────────────────────
        // ახალი კითხვის დასამატებლად:
        // { id: 61, emoji: '🆕', text: 'შენი ახალი კითხვა?' },


    /* ── STATE ── */
    let _sock      = null;
    let _currentQ  = null;
    let _dismissed = new Set();

    /* ── HELPERS ── */
    const $ = function(id) { return document.getElementById(id); };

    function setSock(s) { _sock = s; }

    /* ── SHOW / HIDE ── */
    function _show() {
        // float window გახსნა
        var fw = $('question-float');
        if (!fw) return;
        fw.classList.add('qw-open');

        // screen-ს display:flex
        var screen = $('qw-screen-question');
        if (screen) screen.style.display = 'flex';
    }

    function _hide() {
        var fw = $('question-float');
        if (!fw) return;
        fw.classList.remove('qw-open');
        requestAnimationFrame(function() {
            if (fw.classList.contains('qw-open')) return;
            fw.classList.remove('qw-dragged');
            fw.style.left = '';
            fw.style.top  = '';
        });
    }

    /* ── PICK RANDOM QUESTION ── */
    function _pickAndShow() {
        // გამოყენებული კითხვების გამოკლება
        var available = QUESTIONS.filter(function(q) {
            return !_dismissed.has(q.id);
        });

        // თუ ყველა ამოიწურა — reset და თავიდან
        if (available.length === 0) {
            _dismissed.clear();
            available = QUESTIONS.slice();
        }

        // random არჩევა
        var q = available[Math.floor(Math.random() * available.length)];
        _currentQ = q;

        // პარტნიორთან სინქრონიზაცია
        if (_sock && window.gcHasPartner && window.gcIsInitiator) {
            _sock.emit('question-sync', { questionId: q.id });
        }

        _render(q);
        _show();
    }

    /* ── RENDER ── */
    function _render(q) {
        var emojiEl = $('qw-emoji');
        var textEl  = $('qw-text');
        if (emojiEl) emojiEl.textContent = q.emoji;
        if (textEl)  textEl.textContent  = q.text;
    }

    /* ── PUBLIC ACTIONS ── */
    function openQuestions() {
        _pickAndShow();
    }

    function nextQuestion() {
        if (_currentQ) _dismissed.add(_currentQ.id);
        _pickAndShow();
    }

    /* ── SOCKET: guest-ი იღებს კითხვის ID-ს ── */
    function onQuestionSync(data) {
        var q = null;
        for (var i = 0; i < QUESTIONS.length; i++) {
            if (QUESTIONS[i].id === data.questionId) { q = QUESTIONS[i]; break; }
        }
        if (!q) return;
        _currentQ = q;
        _render(q);
        _show();
    }

    /* ── DRAG ── */
    function _initDrag() {
        var fw     = $('question-float');
        var handle = $('qw-handle');
        if (!fw || !handle) return;

        function startDrag(sx, sy) {
            var rect = fw.getBoundingClientRect();
            var bL = rect.left, bT = rect.top;
            fw.classList.add('qw-dragged');
            fw.style.left = bL + 'px';
            fw.style.top  = bT + 'px';

            function move(cx, cy) {
                var vw = window.innerWidth, vh = window.innerHeight;
                var w  = fw.offsetWidth,   h  = fw.offsetHeight;
                fw.style.left = Math.min(vw - w - 4, Math.max(4, bL + cx - sx)) + 'px';
                fw.style.top  = Math.min(vh - h - 4, Math.max(4, bT + cy - sy)) + 'px';
            }
            function stop() {
                document.removeEventListener('mousemove', onMM);
                document.removeEventListener('mouseup',   stop);
                document.removeEventListener('touchmove', onTM);
                document.removeEventListener('touchend',  stop);
            }
            function onMM(e) { move(e.clientX, e.clientY); }
            function onTM(e) { e.preventDefault(); move(e.touches[0].clientX, e.touches[0].clientY); }

            document.addEventListener('mousemove', onMM);
            document.addEventListener('mouseup',   stop);
            document.addEventListener('touchmove', onTM, { passive: false });
            document.addEventListener('touchend',  stop);
        }

        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            startDrag(e.clientX, e.clientY);
        });
        handle.addEventListener('touchstart', function(e) {
            startDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: true });
    }

    /* ── INIT: ღილაკების მიბმა DOM-ზე ── */
    function _init() {
        _initDrag();

        // X — დახურვა
        var closeBtn = $('qw-close-btn');
        if (closeBtn) {
            closeBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                _hide();
            });
        }

        // შემდეგი კითხვა
        var nextBtn = $('qw-next-btn');
        if (nextBtn) {
            nextBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                nextQuestion();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _init);
    } else {
        setTimeout(_init, 0);
    }

    /* ── PUBLIC API ── */
    return {
        setSock:        setSock,
        openQuestions:  openQuestions,
        nextQuestion:   nextQuestion,
        onQuestionSync: onQuestionSync,
        onXClick:       _hide,
    };

})();