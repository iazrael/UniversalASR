import { UniversalClient } from './universal-client.js';

// DOM 元素引用
const recordBtn = document.getElementById('record-btn');
const btnIcon = document.getElementById('btn-icon');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const timerText = document.getElementById('timer-text');
const wordCountText = document.getElementById('word-count-text');
const transcriptViewport = document.getElementById('transcript-viewport');
const emptyState = document.getElementById('empty-state');
const sentenceList = document.getElementById('sentence-list');
const liveSpeechBubble = document.getElementById('live-speech-bubble');
const liveText = document.getElementById('live-text');
const liveBubbleTag = document.getElementById('live-bubble-tag');
const liveBubbleProvider = document.getElementById('live-bubble-provider');
const waveformCanvas = document.getElementById('waveform-canvas');
const silenceSlider = document.getElementById('silence-slider');
const silenceValText = document.getElementById('silence-val-text');
const langSelect = document.getElementById('lang-select');
const btnToggleSettings = document.getElementById('btn-toggle-settings');
const settingsPanel = document.getElementById('settings-panel');
const btnClear = document.getElementById('btn-clear');
const btnCopyAll = document.getElementById('btn-copy-all');
const btnTestDemo = document.getElementById('btn-test-demo');
const toastMsg = document.getElementById('toast-msg');

// Provider 切换选项
const providerOptions = document.querySelectorAll('.segmented-option');
let currentProvider = 'omlx';

// 运行时状态
let client = new UniversalClient();
let timerInterval = null;
let recordingSeconds = 0;
let recognizedSentences = []; // { id, text, time }
let currentLiveSentenceId = null;

// Canvas 波形绘制
const canvasCtx = waveformCanvas.getContext('2d');
let currentVolume = 0;
let wavePhase = 0;

function setupCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const rect = waveformCanvas.getBoundingClientRect();
  waveformCanvas.width = rect.width * dpr;
  waveformCanvas.height = rect.height * dpr;
  canvasCtx.scale(dpr, dpr);
}

function drawWaveform() {
  const width = waveformCanvas.getBoundingClientRect().width;
  const height = waveformCanvas.getBoundingClientRect().height;

  canvasCtx.clearRect(0, 0, width, height);

  const isRecording = client.getState() === 'RECORDING';
  const midY = height / 2;

  canvasCtx.lineWidth = 2;
  canvasCtx.strokeStyle = isRecording
    ? currentProvider === 'omlx' ? '#10b981' : '#f97316'
    : 'rgba(150, 150, 150, 0.3)';

  canvasCtx.beginPath();
  const bars = 40;
  const step = width / bars;

  for (let i = 0; i < bars; i++) {
    const x = i * step + step / 2;
    let amplitude = 2;

    if (isRecording) {
      // 随麦克风音量与波形动态律动
      const distFromCenter = 1 - Math.abs(i - bars / 2) / (bars / 2);
      const wave = Math.sin(i * 0.3 + wavePhase) * 0.5 + 0.5;
      amplitude = Math.max(3, (currentVolume * 28 + wave * 6) * distFromCenter);
    }

    canvasCtx.moveTo(x, midY - amplitude / 2);
    canvasCtx.lineTo(x, midY + amplitude / 2);
  }
  canvasCtx.stroke();

  if (isRecording) {
    wavePhase += 0.15;
  }
  requestAnimationFrame(drawWaveform);
}

// 初始化 Canvas
setupCanvas();
window.addEventListener('resize', setupCanvas);
requestAnimationFrame(drawWaveform);

// Provider 切换事件
providerOptions.forEach((opt) => {
  opt.addEventListener('click', () => {
    providerOptions.forEach((o) => o.classList.remove('selected', 'omlx-badge', 'aliyun-badge'));
    opt.classList.add('selected');
    const p = opt.getAttribute('data-provider');
    currentProvider = p;
    if (p === 'omlx') {
      opt.classList.add('omlx-badge');
    } else {
      opt.classList.add('aliyun-badge');
    }
    showToast(`ASR 引擎已切换为: ${p === 'omlx' ? 'oMLX (Qwen3-ASR)' : '阿里云 (Paraformer)'}`);
  });
});

// VAD 阈值滑块事件
silenceSlider.addEventListener('input', (e) => {
  silenceValText.textContent = `${e.target.value}ms`;
});

// 设置面板折叠
btnToggleSettings.addEventListener('click', () => {
  settingsPanel.classList.toggle('collapsed');
});

// Toast 提示
function showToast(text) {
  toastMsg.textContent = text;
  toastMsg.classList.add('show');
  setTimeout(() => toastMsg.classList.remove('show'), 2000);
}

// 统计信息刷新
function updateStats() {
  const totalChars = recognizedSentences.reduce((sum, s) => sum + s.text.length, 0);
  wordCountText.textContent = `${totalChars} 字 / ${recognizedSentences.length} 句`;
}

// 计时器控制
function startTimer() {
  recordingSeconds = 0;
  timerText.textContent = '00:00';
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    recordingSeconds++;
    const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
    const secs = String(recordingSeconds % 60).padStart(2, '0');
    timerText.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
}

// 渲染已定稿句子
function appendFinalSentence(sentenceId, text) {
  emptyState.style.display = 'none';

  // 检查是否已有相同 ID 的句子（避免重复）
  let existing = recognizedSentences.find((s) => s.id === sentenceId);
  if (existing) {
    existing.text = text;
    const el = document.getElementById(`sentence-card-${sentenceId}`);
    if (el) {
      el.querySelector('.sentence-text').textContent = text;
    }
  } else {
    const timeStr = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    recognizedSentences.push({ id: sentenceId, text, time: timeStr });

    const bubble = document.createElement('div');
    bubble.className = 'sentence-bubble';
    bubble.id = `sentence-card-${sentenceId}`;
    bubble.innerHTML = `
      <div class="bubble-meta">
        <span class="sentence-tag">句 #${sentenceId}</span>
        <span>${timeStr}</span>
      </div>
      <div class="sentence-text">${escapeHtml(text)}</div>
    `;
    sentenceList.appendChild(bubble);
  }

  // 隐藏 live bubble
  liveSpeechBubble.style.display = 'none';
  liveText.textContent = '';
  updateStats();

  // 自动滚动至底部
  transcriptViewport.scrollTop = transcriptViewport.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// SDK 事件绑定
client
  .on('stateChange', (state) => {
    statusDot.className = 'status-dot';

    if (state === 'CONNECTING') {
      statusText.textContent = '连接与启动中...';
      btnIcon.textContent = '⏳';
      recordBtn.classList.remove('recording');
    } else if (state === 'RECORDING') {
      statusText.textContent = `实时转写中 (${currentProvider.toUpperCase()})`;
      statusDot.classList.add('recording');
      btnIcon.textContent = '⏹️';
      recordBtn.classList.add('recording');
      startTimer();
    } else if (state === 'STOPPING') {
      statusText.textContent = '正在收尾定稿...';
      btnIcon.textContent = '⏳';
      recordBtn.classList.remove('recording');
      stopTimer();
    } else if (state === 'DISCONNECTED') {
      statusText.textContent = '就绪 (空闲)';
      btnIcon.textContent = '🎙️';
      recordBtn.classList.remove('recording');
      stopTimer();
      currentVolume = 0;
    }
  })
  .on('started', (data) => {
    showToast(`ASR 会话已建立 (Provider: ${data.provider})`);
  })
  .on('transcript', (result) => {
    const { text, is_final, sentence_id } = result;

    if (is_final) {
      appendFinalSentence(sentence_id || recognizedSentences.length + 1, text);
    } else {
      // 实时增量展示
      emptyState.style.display = 'none';
      liveSpeechBubble.style.display = 'flex';
      liveBubbleTag.textContent = `句 #${sentence_id || recognizedSentences.length + 1} (实时中)`;
      liveBubbleProvider.textContent = currentProvider.toUpperCase();
      liveText.textContent = text;
      transcriptViewport.scrollTop = transcriptViewport.scrollHeight;
    }
  })
  .on('volume', (vol) => {
    currentVolume = vol;
  })
  .on('completed', (data) => {
    showToast(`识别完成！总时长: ${((data.durationMs || 0) / 1000).toFixed(1)}s`);
  })
  .on('error', (err) => {
    console.error('ASR Client Error:', err);
    showToast(`错误: ${err.message}`);
  });

// 录音主按钮点击
recordBtn.addEventListener('click', async () => {
  const state = client.getState();

  if (state === 'RECORDING' || state === 'CONNECTING') {
    // 停止录音
    await client.stop();
  } else if (state === 'DISCONNECTED') {
    // 启动录音
    const maxSilence = parseInt(silenceSlider.value, 10);
    const language = langSelect.value;

    await client.start({
      provider: currentProvider,
      language,
      maxSentenceSilence: maxSilence,
      enableVad: true,
    });
  }
});

// 清空文本
btnClear.addEventListener('click', () => {
  recognizedSentences = [];
  sentenceList.innerHTML = '';
  liveSpeechBubble.style.display = 'none';
  liveText.textContent = '';
  emptyState.style.display = 'flex';
  updateStats();
  showToast('文本已清空');
});

// 复制全文
btnCopyAll.addEventListener('click', () => {
  if (recognizedSentences.length === 0) {
    showToast('暂无转写内容可复制');
    return;
  }
  const fullText = recognizedSentences.map((s) => s.text).join('\n');
  navigator.clipboard.writeText(fullText).then(() => {
    showToast('已复制全文到剪贴板 ✅');
  });
});

// 示例评测按钮（通过服务端预置测试流进行快速体验）
btnTestDemo.addEventListener('click', () => {
  showToast('请直接点击大麦克风对着电脑/手机说话即可体验实时 ASR！');
});
