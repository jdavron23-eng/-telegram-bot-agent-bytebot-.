const tg = window.Telegram.WebApp;
tg.expand();

let quizData = [];
let currentQuestion = 0;
let score = 0;
let canAnswer = true;

// Extract userId from URL parameters
const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get('userId');
const teamId = urlParams.get('teamId');

// Fetch the actual AI-generated questions from our Express API
async function fetchQuizData() {
    if (!userId && !teamId) return false;
    
    try {
        const url = teamId ? `/api/quiz/team/${teamId}` : `/api/quiz/${userId}`;
        console.log("Fetching quiz from:", url);
        const response = await fetch(url);
        if (!response.ok) {
            console.error("Fetch failed with status:", response.status);
            return false;
        }
        
        const data = await response.json();
        console.log("Quiz data received:", data ? "Yes" : "No");
        if (data) {
            // New format: { topic, questions }
            // Old format: [ questions... ]
            if (Array.isArray(data)) {
                quizData = data;
            } else if (data.questions) {
                quizData = data.questions;
                const topicEl = document.getElementById('quiz-topic');
                if (topicEl) topicEl.textContent = data.topic || "Mavzu topilmadi";
            }
            return true;
        }
    } catch (e) {
        console.error("Quiz fetching error", e);
    }
    return false;
}

// DOM Elements
const startScreen = document.getElementById('start-screen');
const quizScreen = document.getElementById('quiz-screen');
const resultScreen = document.getElementById('result-screen');
const startBtn = document.getElementById('start-btn');
const closeBtn = document.getElementById('close-btn');
const retryBtn = document.getElementById('retry-btn');

const questionText = document.getElementById('question-text');
const optionsContainer = document.getElementById('options-container');
const progressBar = document.getElementById('progress-bar');
const questionIndicator = document.getElementById('question-indicator');
const scoreIndicator = document.getElementById('score-indicator');

const finalScore = document.getElementById('final-score');
const resultMessage = document.getElementById('result-message');
const scoreCircle = document.querySelector('.score-circle');
const resultIcon = document.getElementById('result-icon');
const totalScoreEl = document.querySelector('.total-score');

// Init
tg.MainButton.hide();
tg.ready();

// Apply Theme colors
document.documentElement.style.setProperty('--accent-color', tg.themeParams.button_color || '#007aff');
document.documentElement.style.setProperty('--tg-theme-button-text-color', tg.themeParams.button_text_color || '#ffffff');

// Initialization
startBtn.textContent = "Yuklanmoqda...";
startBtn.disabled = true;

fetchQuizData().then(success => {
    if (success) {
        startBtn.textContent = "Testni Boshlash";
        startBtn.disabled = false;
        startBtn.addEventListener('click', startQuiz);
        
        // Update the subtitle text to show the correct count
        const subtitle = document.querySelector('#start-screen p');
        if(subtitle) subtitle.textContent = `O'z bilimingizni sinab ko'rishga tayyormisiz? ${quizData.length} ta savol sizni kutmoqda.`;
    } else {
        startBtn.textContent = "Test topilmadi!";
        const subtitle = document.querySelector('#start-screen p');
        if(subtitle) subtitle.textContent = "Ushbu test eskirgan yoki topilmadi. Iltimos, bot orqali yangi test yarating.";
    }
});

closeBtn.addEventListener('click', closeApp);
retryBtn.addEventListener('click', () => {
    currentQuestion = 0;
    score = 0;
    updateScore();
    switchScreen('result-screen', 'start-screen');
    startBtn.textContent = "Testni Boshlash";
    startBtn.disabled = false;
});

function switchScreen(hideId, showId) {
    document.getElementById(hideId).classList.remove('active');
    document.getElementById(showId).classList.add('active');
}

function startQuiz() {
    // Optional: Provide haptic feedback
    if(tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    
    // Shuffle options for all questions before starting
    quizData.forEach(q => {
        const originalOptions = [...q.options];
        const correctAnswer = originalOptions[q.correct];
        
        // Shuffle
        for (let i = q.options.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [q.options[i], q.options[j]] = [q.options[j], q.options[i]];
        }
        
        // Update correct index
        q.correct = q.options.indexOf(correctAnswer);
    });

    currentQuestion = 0;
    score = 0;
    updateScore();
    switchScreen('start-screen', 'quiz-screen');
    loadQuestion();
}

function loadQuestion() {
    canAnswer = true;
    const q = quizData[currentQuestion];
    
    // Update progress
    const progressPercent = ((currentQuestion) / quizData.length) * 100;
    progressBar.style.width = `${progressPercent}%`;
    questionIndicator.textContent = `${currentQuestion + 1}/${quizData.length}`;
    
    // Add animation class
    questionText.parentElement.classList.remove('slide-in');
    void questionText.parentElement.offsetWidth; // trigger reflow
    questionText.parentElement.classList.add('slide-in');
    
    questionText.textContent = q.question;
    
    // Clear options
    optionsContainer.innerHTML = '';
    
    // Render options
    q.options.forEach((opt, index) => {
        const btn = document.createElement('button');
        btn.className = 'option-btn slide-in';
        btn.style.animationDelay = `${index * 0.1}s`;
        
        btn.innerHTML = `
            <span>${opt}</span>
            <span class="icon"></span>
        `;
        
        btn.addEventListener('click', () => selectOption(btn, index));
        optionsContainer.appendChild(btn);
    });
}

function selectOption(btn, selectedIndex) {
    if (!canAnswer) return;
    canAnswer = false;
    
    const q = quizData[currentQuestion];
    const isCorrect = selectedIndex === q.correct;
    
    const allBtns = optionsContainer.querySelectorAll('.option-btn');
    
    if (isCorrect) {
        if(tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
        btn.classList.add('correct');
        btn.querySelector('.icon').textContent = '✅';
        score++;
        updateScore();
    } else {
        if(tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('error');
        btn.classList.add('wrong');
        btn.querySelector('.icon').textContent = '❌';
        
        // Highlight correct
        allBtns[q.correct].classList.add('correct');
        allBtns[q.correct].querySelector('.icon').textContent = '✅';
    }
    
    // Wait then next question
    setTimeout(() => {
        currentQuestion++;
        if (currentQuestion < quizData.length) {
            loadQuestion();
        } else {
            showResult();
        }
    }, 1200);
}

function updateScore() {
    scoreIndicator.textContent = `🌟 ${score}`;
}

function showResult() {
    if(tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    
    progressBar.style.width = '100%';
    
    setTimeout(() => {
        switchScreen('quiz-screen', 'result-screen');
        
        finalScore.textContent = score;
        totalScoreEl.textContent = `/ ${quizData.length}`;
        
        const percentage = Math.round((score / quizData.length) * 100);
        
        // Update score circle gradient
        scoreCircle.style.background = `conic-gradient(var(--accent-color) ${percentage}%, var(--tg-theme-secondary-bg-color) 0%)`;
        
        if (percentage === 100) {
            resultMessage.textContent = "Mukammal! Siz hamma savolga to'g'ri javob berdingiz! 🥇";
            resultIcon.textContent = "🥇";
        } else if (percentage >= 70) {
            resultMessage.textContent = "Ajoyib natija! Sizda yaxshi bilim bor. 👏";
            resultIcon.textContent = "🌟";
        } else if (percentage >= 40) {
            resultMessage.textContent = "Yomon emas, lekin yanada yaxshiroq o'qishingiz kerak. 👍";
            resultIcon.textContent = "📚";
        } else {
            resultMessage.textContent = "Ko'proq izlanish kerak. Keyingi safar albatta o'xshaydi! 💪";
            resultIcon.textContent = "😅";
        }
        
        // Auto send result to server
        sendResultAuto();
        
    }, 500);
}

async function sendResultAuto() {
    if (!userId && !teamId) {
        console.error("userId yoki teamId topilmadi, natija yuborilmadi.");
        return;
    }
    
    // Foydalanuvchi ma'lumotlarini olish
    const user = tg.initDataUnsafe.user || {};
    const firstName = user.first_name || "Noma'lum";
    const userNick = user.username ? `@${user.username}` : "Mavjud emas";
    
    console.log(`Natija yuborilmoqda: UserID=${userId}, Score=${score}/${quizData.length}`);
    
    try {
        const response = await fetch('/api/quiz-result', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId,
                teamId: teamId,
                score: score,
                total: quizData.length,
                name: firstName,
                username: userNick
            })
        });
        const result = await response.json();
        console.log("Server javobi:", result);
    } catch (e) {
        console.error("Avtomatik yuborishda xatolik:", e);
    }
}

function closeApp() {
    tg.close();
}

function closeAndSendData() {
    const data = JSON.stringify({
        action: 'quiz_completed',
        score: score,
        total: quizData.length
    });
    
    tg.sendData(data);
}
