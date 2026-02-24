// =============================================
//  SMA Strategy Backtester — Binance Futures
// =============================================

const API_BASE = "https://fapi.binance.com/fapi/v1";
const MIN_CANDLES = 200;
const TRADE_COOLDOWN = 10;        // velas de espera tras un trade
const MAX_TRADE_DURATION = 50;    // velas máximas para resolver un trade
const MAINT_MARGIN_RATE = 0.004;  // 0.4% margen de mantenimiento (simplificado Binance)
const TAKER_FEE = 0.0004;         // 0.04% comisión taker (market orders)
const MAKER_FEE = 0.0002;         // 0.02% comisión maker (limit orders)
const USE_FEE = TAKER_FEE;        // Usar taker fee (más conservador)

// ── Patrones de velas japonesas (technicalindicators v2.0.6) ──
const PATTERN_WINDOW = 5;
const CANDLE_PATTERNS = {
    bullish: [
        { name: 'Bullish Engulfing',    fn: 'bullishengulfingpattern',  icon: '🟢', weight: 2 },
        { name: 'Bullish Harami',       fn: 'bullishharami',            icon: '🟢', weight: 1 },
        { name: 'Morning Star',         fn: 'morningstar',              icon: '⭐', weight: 2 },
        { name: 'Morning Doji Star',    fn: 'morningdojistar',          icon: '⭐', weight: 2 },
        { name: 'Hammer',               fn: 'hammerpattern',            icon: '🔨', weight: 1 },
        { name: 'Piercing Line',        fn: 'piercingline',             icon: '📈', weight: 1 },
        { name: 'Three White Soldiers', fn: 'threewhitesoldiers',       icon: '🪖', weight: 2 },
        { name: 'Tweezer Bottom',       fn: 'tweezerbottom',            icon: '📈', weight: 1 },
    ],
    bearish: [
        { name: 'Bearish Engulfing',    fn: 'bearishengulfingpattern',  icon: '🔴', weight: 2 },
        { name: 'Bearish Harami',       fn: 'bearishharami',            icon: '🔴', weight: 1 },
        { name: 'Evening Star',         fn: 'eveningstar',              icon: '🌙', weight: 2 },
        { name: 'Evening Doji Star',    fn: 'eveningdojistar',          icon: '🌙', weight: 2 },
        { name: 'Shooting Star',        fn: 'shootingstar',             icon: '💫', weight: 1 },
        { name: 'Dark Cloud Cover',     fn: 'darkcloudcover',           icon: '☁️', weight: 1 },
        { name: 'Three Black Crows',    fn: 'threeblackcrows',          icon: '🐦', weight: 2 },
        { name: 'Tweezer Top',          fn: 'tweezertop',               icon: '📉', weight: 1 },
    ]
};

function detectCandlePatterns(opens, highs, lows, closes, index) {
    const start = Math.max(0, index - PATTERN_WINDOW + 1);
    const input = {
        open:  opens.slice(start, index + 1),
        high:  highs.slice(start, index + 1),
        close: closes.slice(start, index + 1),
        low:   lows.slice(start, index + 1),
    };

    const bullishPatterns = [];
    const bearishPatterns = [];
    let score = 0;

    for (const p of CANDLE_PATTERNS.bullish) {
        try {
            if (typeof window[p.fn] === 'function' && window[p.fn](input)) {
                bullishPatterns.push(p);
                score += p.weight;
            }
        } catch (e) { /* pattern unavailable */ }
    }

    for (const p of CANDLE_PATTERNS.bearish) {
        try {
            if (typeof window[p.fn] === 'function' && window[p.fn](input)) {
                bearishPatterns.push(p);
                score -= p.weight;
            }
        } catch (e) { /* pattern unavailable */ }
    }

    return { bullishPatterns, bearishPatterns, score };
}

// ── Estado global ──────────────────────────────
let isScanning = false;
let resultsData = [];  // almacena datos para ordenación

// ── Elementos del DOM (cache) ──────────────────
const DOM = {
    btnStart:       document.getElementById('btnStart'),
    btnText:        document.getElementById('btnText'),
    status:         document.getElementById('status'),
    tbody:          document.getElementById('resultsBody'),
    progressBar:    document.getElementById('progressBar'),
    progressText:   document.getElementById('progressText'),
    progressContainer: document.getElementById('progressContainer'),
    summary:        document.getElementById('summary'),
    emptyState:     document.getElementById('emptyState'),
    sumTotal:       document.getElementById('sumTotal'),
    sumBuy:         document.getElementById('sumBuy'),
    sumSell:        document.getElementById('sumSell'),
    sumBestROI:     document.getElementById('sumBestROI'),
    // Market sentiment panel
    marketSentiment:  document.getElementById('marketSentiment'),
    sentimentIcon:    document.getElementById('sentimentIcon'),
    sentimentTitle:   document.getElementById('sentimentTitle'),
    sentimentDesc:    document.getElementById('sentimentDesc'),
    meterBull:        document.getElementById('meterBull'),
    meterBear:        document.getElementById('meterBear'),
    meterNeutral:     document.getElementById('meterNeutral'),
    meterBullPct:     document.getElementById('meterBullPct'),
    meterBearPct:     document.getElementById('meterBearPct'),
    meterNeutralPct:  document.getElementById('meterNeutralPct'),
    chipBtcTrend:     document.getElementById('chipBtcTrend'),
    chipAvgRsi:       document.getElementById('chipAvgRsi'),
    chipVolatility:   document.getElementById('chipVolatility'),
    chipMomentum:     document.getElementById('chipMomentum'),
    chipPatterns:     document.getElementById('chipPatterns'),
};

// ── Leer parámetros del usuario ────────────────
function getParams() {
    return {
        capital:    parseFloat(document.getElementById('capital').value)   || 1000,
        leverage:   parseFloat(document.getElementById('leverage').value)  || 10,
        timeframe:  document.getElementById('timeframe').value,
        tpPercent:  (parseFloat(document.getElementById('tp').value) || 3) / 100,
        limitVelas: parseInt(document.getElementById('limitKlines').value) || 500,
        topPairs:     parseInt(document.getElementById('topPairs').value)    || 20,
        patternMode:  document.getElementById('patternMode').value          || 'off',
    };
}

// ── Guardar y cargar configuración ─────────────
const CONFIG_KEY = 'smaStrategyConfig';

function saveConfig() {
    const config = {
        capital:     document.getElementById('capital').value,
        leverage:    document.getElementById('leverage').value,
        timeframe:   document.getElementById('timeframe').value,
        tp:          document.getElementById('tp').value,
        limitKlines: document.getElementById('limitKlines').value,
        topPairs:    document.getElementById('topPairs').value,
        patternMode: document.getElementById('patternMode').value,
    };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

function loadConfig() {
    const saved = localStorage.getItem(CONFIG_KEY);
    if (saved) {
        try {
            const config = JSON.parse(saved);
            if (config.capital)     document.getElementById('capital').value     = config.capital;
            if (config.leverage)    document.getElementById('leverage').value    = config.leverage;
            if (config.timeframe)   document.getElementById('timeframe').value   = config.timeframe;
            if (config.tp)          document.getElementById('tp').value          = config.tp;
            if (config.limitKlines) document.getElementById('limitKlines').value = config.limitKlines;
            if (config.topPairs)    document.getElementById('topPairs').value    = config.topPairs;
            if (config.patternMode) document.getElementById('patternMode').value = config.patternMode;
        } catch (err) {
            console.warn('Error cargando configuración:', err);
        }
    }
}

// ── Eventos ────────────────────────────────────
DOM.btnStart.addEventListener('click', startProcess);

// Guardar configuración cuando cambian los inputs
document.getElementById('capital').addEventListener('change', saveConfig);
document.getElementById('leverage').addEventListener('change', saveConfig);
document.getElementById('timeframe').addEventListener('change', saveConfig);
document.getElementById('tp').addEventListener('change', saveConfig);
document.getElementById('limitKlines').addEventListener('change', saveConfig);
document.getElementById('topPairs').addEventListener('change', saveConfig);
document.getElementById('patternMode').addEventListener('change', saveConfig);

// Cargar configuración guardada al iniciar
document.addEventListener('DOMContentLoaded', loadConfig);

// Ordenación de columnas
document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => sortTable(th.dataset.sort));
});

// ── Proceso principal ──────────────────────────
// Verificar que la librería de patrones está disponible
function checkPatternLibrary() {
    return new Promise((resolve) => {
        let attempts = 0;
        const checkLib = () => {
            attempts++;
            // Si la librería no está disponible o TensorFlow no cargó, continuar de todos modos
            const hasLib = typeof window.bullishengulfingpattern === 'function' || attempts > 30;
            resolve(true);
        };
        setTimeout(checkLib, 100);
    });
}

async function startProcess() {
    if (isScanning) return;

    const params = getParams();

    if (params.limitVelas < MIN_CANDLES) {
        showNotification(`Se necesitan al menos ${MIN_CANDLES} velas para la SMA 200.`, 'error');
        return;
    }
    if (params.capital <= 0 || params.leverage <= 0) {
        showNotification('Capital y apalancamiento deben ser mayores a 0.', 'error');
        return;
    }

    // Verificar que la librería de patrones está cargada
    await checkPatternLibrary();

    isScanning = true;
    resultsData = [];
    DOM.tbody.innerHTML = '';
    DOM.emptyState.classList.add('hidden');
    DOM.summary.classList.add('hidden');
    DOM.marketSentiment.classList.add('hidden');
    setProgress(0);
    DOM.progressContainer.classList.remove('hidden');
    toggleButton(true);

    try {
        DOM.status.textContent = "Obteniendo pares con mayor volumen...";
        const topPairs = await getTopVolumePairs(params.topPairs);

        if (topPairs.length === 0) {
            throw new Error("No se encontraron pares USDT en Binance Futures.");
        }

        for (let idx = 0; idx < topPairs.length; idx++) {
            const symbol = topPairs[idx];
            DOM.status.textContent = `Analizando ${symbol} (${idx + 1}/${topPairs.length})...`;

            try {
                const klines = await fetchKlines(symbol, params);
                if (klines.length < MIN_CANDLES) {
                    setProgress(((idx + 1) / topPairs.length) * 100);
                    continue;
                }

                const analysis = runBacktest(klines, params);
                resultsData.push({ symbol, ...analysis });
                renderRow(symbol, analysis, resultsData.length);
            } catch (pairErr) {
                console.warn(`⚠️ Error analizando ${symbol}:`, pairErr.message);
            }

            setProgress(((idx + 1) / topPairs.length) * 100);
            await sleep(120);
        }

        updateSummary();
        updateMarketSentiment();
        DOM.status.textContent = `✅ Análisis finalizado — ${resultsData.length} pares procesados.`;
    } catch (err) {
        DOM.status.textContent = "❌ Error: " + err.message;
        console.error(err);
    } finally {
        isScanning = false;
        toggleButton(false);
    }
}

// ── API: pares con mayor volumen ───────────────
async function getTopVolumePairs(limit) {
    const res = await fetchWithRetry(`${API_BASE}/ticker/24hr`);
    const data = await res.json();

    return data
        .filter(d => d.symbol.endsWith("USDT"))
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, limit)
        .map(d => d.symbol);
}

// ── API: obtener velas ─────────────────────────
async function fetchKlines(symbol, params) {
    const res = await fetchWithRetry(
        `${API_BASE}/klines?symbol=${symbol}&interval=${params.timeframe}&limit=${params.limitVelas}`
    );
    const data = await res.json();

    if (!Array.isArray(data)) {
        throw new Error(`Respuesta inválida para ${symbol}`);
    }
    return data;
}

// ── Fetch con reintentos ───────────────────────
async function fetchWithRetry(url, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url);
            if (res.status === 429) {
                // Rate limit: esperar antes de reintentar
                const wait = Math.pow(2, attempt) * 1000;
                console.warn(`Rate limit, reintentando en ${wait}ms...`);
                await sleep(wait);
                continue;
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            return res;
        } catch (err) {
            if (attempt === retries) throw err;
            await sleep(1000 * attempt);
        }
    }
}

// ── Backtesting ────────────────────────────────
function runBacktest(klines, params) {
    const closes = klines.map(k => parseFloat(k[4]));
    const highs  = klines.map(k => parseFloat(k[2]));
    const lows   = klines.map(k => parseFloat(k[3]));
    const opens  = klines.map(k => parseFloat(k[1]));

    const patternMode = params.patternMode || 'off';

    const sma200 = calculateSMA(closes, 200);
    const sma100 = calculateSMA(closes, 100);
    const sma50  = calculateSMA(closes, 50);
    const sma30  = calculateSMA(closes, 30);

    let capital = params.capital;
    const initialCapital = capital;
    const { leverage: lev, tpPercent } = params;

    let trades = 0;
    let wins = 0;
    let liquidations = 0;
    let unresolvedTrades = 0;
    let maxDrawdown = 0;
    let peakCapital = capital;

    for (let i = MIN_CANDLES; i < closes.length - 1; i++) {
        const price = closes[i];
        let type = null;

        const smaLong  = price > sma200[i] && sma30[i] > sma50[i] && sma50[i] > sma100[i];
        const smaShort = price < sma200[i] && sma30[i] < sma50[i] && sma50[i] < sma100[i];

        let btPatterns = { bullishPatterns: [], bearishPatterns: [], score: 0 };
        if (patternMode !== 'off') {
            btPatterns = detectCandlePatterns(opens, highs, lows, closes, i);
        }

        // Determinar señal según modo de patrones
        if (patternMode === 'confirm') {
            if (smaLong && btPatterns.score > 0) type = 'long';
            else if (smaShort && btPatterns.score < 0) type = 'short';
        } else if (patternMode === 'expand') {
            if (smaLong) type = 'long';
            else if (smaShort) type = 'short';
            else if (btPatterns.score >= 3 && price > sma200[i]) type = 'long';
            else if (btPatterns.score <= -3 && price < sma200[i]) type = 'short';
        } else {
            if (smaLong) type = 'long';
            else if (smaShort) type = 'short';
        }

        if (type) {
            trades++;
            const entryPrice = price;
            const targetPrice = type === 'long'
                ? entryPrice * (1 + tpPercent)
                : entryPrice * (1 - tpPercent);

            // Precio de liquidación (fórmula simplificada Binance Futures)
            const liqPrice = type === 'long'
                ? entryPrice * (1 - (1 / lev) + MAINT_MARGIN_RATE)
                : entryPrice * (1 + (1 / lev) - MAINT_MARGIN_RATE);

            let outcome = 0;   // 0 = sin resolver, 1 = TP, -2 = liquidado
            let exitCandle = Math.min(i + MAX_TRADE_DURATION, closes.length) - 1;
            for (let j = i + 1; j < Math.min(i + MAX_TRADE_DURATION, closes.length); j++) {
                if (type === 'long') {
                    // Primero chequear liquidación (peor caso)
                    if (lows[j] <= liqPrice)      { outcome = -2; exitCandle = j; break; }
                    if (highs[j] >= targetPrice)   { outcome = 1;  exitCandle = j; break; }
                } else {
                    if (highs[j] >= liqPrice)      { outcome = -2; exitCandle = j; break; }
                    if (lows[j]  <= targetPrice)    { outcome = 1;  exitCandle = j; break; }
                }
            }

            // Calcular comisiones (entrada + salida) sobre valor de posición
            const positionValue = capital * lev;
            const totalFees = positionValue * USE_FEE * 2; // entrada + salida

            if (outcome === 1) {
                wins++;
                // Ganancia: TP alcanzado menos comisiones
                capital += capital * tpPercent * lev - totalFees;
            } else if (outcome === -2) {
                liquidations++;
                // Liquidación: pérdida total del margen (capital asignado al trade)
                capital = 0;
            } else {
                // Trade sin resolver: cerrar al precio de cierre de última vela
                unresolvedTrades++;
                const exitPrice = closes[exitCandle];
                const pnlPercent = type === 'long'
                    ? (exitPrice - entryPrice) / entryPrice
                    : (entryPrice - exitPrice) / entryPrice;
                capital += capital * pnlPercent * lev - totalFees;
            }

            // Clamp: el capital no puede ser negativo
            capital = Math.max(capital, 0);

            // Drawdown tracking
            peakCapital = Math.max(peakCapital, capital);
            const drawdown = peakCapital > 0
                ? ((peakCapital - capital) / peakCapital) * 100
                : 0;
            maxDrawdown = Math.max(maxDrawdown, drawdown);

            i += TRADE_COOLDOWN;
        }
    }

    // ── Señal en vivo ──
    const last = closes.length - 1;
    let liveSignal = null;

    const liveSmaLong  = closes[last] > sma200[last] && sma30[last] > sma50[last] && sma50[last] > sma100[last];
    const liveSmaShort = closes[last] < sma200[last] && sma30[last] < sma50[last] && sma50[last] < sma100[last];

    let livePatterns = { bullishPatterns: [], bearishPatterns: [], score: 0 };
    if (patternMode !== 'off') {
        livePatterns = detectCandlePatterns(opens, highs, lows, closes, last);
    }

    if (patternMode === 'confirm') {
        if (liveSmaLong && livePatterns.score > 0) liveSignal = 'BUY';
        else if (liveSmaShort && livePatterns.score < 0) liveSignal = 'SELL';
    } else if (patternMode === 'expand') {
        if (liveSmaLong) liveSignal = 'BUY';
        else if (liveSmaShort) liveSignal = 'SELL';
        else if (livePatterns.score >= 3 && closes[last] > sma200[last]) liveSignal = 'BUY';
        else if (livePatterns.score <= -3 && closes[last] < sma200[last]) liveSignal = 'SELL';
    } else {
        if (liveSmaLong) liveSignal = 'BUY';
        else if (liveSmaShort) liveSignal = 'SELL';
    }

    const roi = ((capital - initialCapital) / initialCapital * 100);

    // Calcular RSI actual (14 períodos)
    const rsi14 = calculateRSI(closes, 14);
    const currentRSI = rsi14[rsi14.length - 1];

    // Calcular volatilidad (desv. estándar de últimas 20 velas como % del precio)
    const recentCloses = closes.slice(-20);
    const mean = recentCloses.reduce((a, b) => a + b, 0) / recentCloses.length;
    const variance = recentCloses.reduce((sum, c) => sum + Math.pow(c - mean, 2), 0) / recentCloses.length;
    const volatility = (Math.sqrt(variance) / mean) * 100;

    // Momentum: cambio porcentual en las últimas 10 velas
    const momentum = closes.length >= 10
        ? ((closes[last] - closes[last - 10]) / closes[last - 10]) * 100
        : 0;

    return {
        roi:          roi.toFixed(2),
        roiNum:       roi,
        winRate:      trades > 0 ? ((wins / trades) * 100).toFixed(1) : '0.0',
        winRateNum:   trades > 0 ? (wins / trades) * 100 : 0,
        trades,
        wins,
        liquidations,
        unresolvedTrades,
        maxDrawdown:  maxDrawdown.toFixed(1),
        liveSignal,
        currentTrend: closes[last] > sma200[last] ? "Alcista" : "Bajista",
        currentRSI:   currentRSI !== null ? currentRSI : 50,
        volatility:   volatility,
        momentum:     momentum,
        livePatterns: livePatterns,
    };
}

// ── RSI (Relative Strength Index) ──────────────
function calculateRSI(closes, period = 14) {
    const rsi = new Array(closes.length).fill(null);
    if (closes.length < period + 1) return rsi;

    let gainSum = 0, lossSum = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gainSum += diff;
        else lossSum += Math.abs(diff);
    }

    let avgGain = gainSum / period;
    let avgLoss = lossSum / period;
    rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? Math.abs(diff) : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return rsi;
}

// ── Análisis del mercado general ───────────────
function updateMarketSentiment() {
    if (resultsData.length === 0) return;

    const bullish  = resultsData.filter(r => r.currentTrend === 'Alcista').length;
    const bearish  = resultsData.filter(r => r.currentTrend === 'Bajista').length;
    const total    = resultsData.length;
    const neutral  = total - bullish - bearish;

    const bullPct    = ((bullish / total) * 100).toFixed(1);
    const bearPct    = ((bearish / total) * 100).toFixed(1);
    const neutralPct = ((neutral / total) * 100).toFixed(1);

    // Barras de medición
    DOM.meterBull.style.width    = bullPct + '%';
    DOM.meterBear.style.width    = bearPct + '%';
    DOM.meterNeutral.style.width = neutralPct + '%';
    DOM.meterBullPct.textContent    = `${bullPct}% (${bullish})`;
    DOM.meterBearPct.textContent    = `${bearPct}% (${bearish})`;
    DOM.meterNeutralPct.textContent = `${neutralPct}% (${neutral})`;

    // RSI promedio
    const avgRSI = resultsData.reduce((s, r) => s + (r.currentRSI || 50), 0) / total;
    const avgVolatility = resultsData.reduce((s, r) => s + (r.volatility || 0), 0) / total;
    const avgMomentum = resultsData.reduce((s, r) => s + (r.momentum || 0), 0) / total;

    // BTC trend (buscar BTCUSDT en resultados)
    const btcData = resultsData.find(r => r.symbol === 'BTCUSDT');
    const btcTrend = btcData ? btcData.currentTrend : '—';
    const btcRSI = btcData ? btcData.currentRSI.toFixed(1) : '—';

    // Chips informativos
    DOM.chipBtcTrend.textContent   = `BTC: ${btcTrend}${btcData ? ` (RSI ${btcRSI})` : ''}`;
    DOM.chipBtcTrend.className     = `detail-chip ${btcTrend === 'Alcista' ? 'chip-bull' : btcTrend === 'Bajista' ? 'chip-bear' : ''}`;
    DOM.chipAvgRsi.textContent     = `RSI Prom: ${avgRSI.toFixed(1)}`;
    DOM.chipAvgRsi.className       = `detail-chip ${avgRSI > 60 ? 'chip-bull' : avgRSI < 40 ? 'chip-bear' : 'chip-neutral'}`;
    DOM.chipVolatility.textContent  = `Volatilidad: ${avgVolatility.toFixed(2)}%`;
    DOM.chipVolatility.className    = `detail-chip ${avgVolatility > 3 ? 'chip-bear' : avgVolatility < 1 ? 'chip-bull' : 'chip-neutral'}`;
    DOM.chipMomentum.textContent    = `Momentum: ${avgMomentum >= 0 ? '+' : ''}${avgMomentum.toFixed(2)}%`;
    DOM.chipMomentum.className      = `detail-chip ${avgMomentum > 1 ? 'chip-bull' : avgMomentum < -1 ? 'chip-bear' : 'chip-neutral'}`;

    // Chip de patrones de velas
    if (DOM.chipPatterns) {
        const pBull = resultsData.reduce((s, r) => s + (r.livePatterns ? r.livePatterns.bullishPatterns.length : 0), 0);
        const pBear = resultsData.reduce((s, r) => s + (r.livePatterns ? r.livePatterns.bearishPatterns.length : 0), 0);
        DOM.chipPatterns.textContent = `Patrones: 🟢${pBull} / 🔴${pBear}`;
        DOM.chipPatterns.className = `detail-chip ${pBull > pBear ? 'chip-bull' : pBear > pBull ? 'chip-bear' : 'chip-neutral'}`;
    }

    // Determinar sentimiento general
    // Puntaje ponderado: tendencias + RSI + momentum + BTC
    let score = 0;
    // Factor 1: Proporción alcistas vs bajistas (-50 a +50)
    score += ((bullish - bearish) / total) * 50;
    // Factor 2: RSI promedio (-20 a +20)
    score += (avgRSI - 50) * 0.4;
    // Factor 3: Momentum promedio (-15 a +15)
    score += Math.max(-15, Math.min(15, avgMomentum * 3));
    // Factor 4: BTC como líder (-15 a +15)
    if (btcData) {
        score += btcData.currentTrend === 'Alcista' ? 10 : -10;
        score += (btcData.currentRSI - 50) * 0.1;
    }
    // Factor 5: Ratio de patrones de velas
    const ptBull = resultsData.reduce((s, r) => s + (r.livePatterns ? r.livePatterns.bullishPatterns.length : 0), 0);
    const ptBear = resultsData.reduce((s, r) => s + (r.livePatterns ? r.livePatterns.bearishPatterns.length : 0), 0);
    const ptTotal = ptBull + ptBear;
    if (ptTotal > 0) {
        score += ((ptBull - ptBear) / ptTotal) * 10;
    }

    let sentimentClass, icon, title, desc;

    if (score > 20) {
        sentimentClass = 'sentiment-bullish';
        icon = '🟢';
        title = 'MERCADO ALCISTA';
        desc = `El mercado muestra fuerza compradora. ${bullish} de ${total} pares están en tendencia alcista. Momentum promedio: ${avgMomentum >= 0 ? '+' : ''}${avgMomentum.toFixed(2)}%.`;
    } else if (score > 5) {
        sentimentClass = 'sentiment-slightly-bullish';
        icon = '🟡🟢';
        title = 'MERCADO LIGERAMENTE ALCISTA';
        desc = `Tendencia positiva moderada. ${bullish} pares alcistas vs ${bearish} bajistas. Precaución recomendada.`;
    } else if (score < -20) {
        sentimentClass = 'sentiment-bearish';
        icon = '🔴';
        title = 'MERCADO BAJISTA';
        desc = `El mercado muestra presión vendedora. ${bearish} de ${total} pares están en tendencia bajista. Momentum promedio: ${avgMomentum >= 0 ? '+' : ''}${avgMomentum.toFixed(2)}%.`;
    } else if (score < -5) {
        sentimentClass = 'sentiment-slightly-bearish';
        icon = '🟡🔴';
        title = 'MERCADO LIGERAMENTE BAJISTA';
        desc = `Tendencia negativa moderada. ${bearish} pares bajistas vs ${bullish} alcistas. Precaución recomendada.`;
    } else {
        sentimentClass = 'sentiment-neutral';
        icon = '🟡';
        title = 'MERCADO INDECISO';
        desc = `No hay una dirección clara. ${bullish} alcistas, ${bearish} bajistas. Esperar confirmación antes de operar.`;
    }

    DOM.sentimentIcon.textContent  = icon;
    DOM.sentimentTitle.textContent = title;
    DOM.sentimentDesc.textContent  = desc;

    // Limpiar clases anteriores y aplicar nueva
    DOM.marketSentiment.className = `market-sentiment ${sentimentClass} fade-in`;
}

// ── SMA optimizada con acumulador ──────────────
function calculateSMA(data, period) {
    const sma = new Array(data.length).fill(null);
    if (data.length < period) return sma;

    // Suma inicial
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i];
    }
    sma[period - 1] = sum / period;

    // Ventana deslizante O(1) por iteración
    for (let i = period; i < data.length; i++) {
        sum += data[i] - data[i - period];
        sma[i] = sum / period;
    }
    return sma;
}

// ── Renderizar fila ────────────────────────────
function renderRow(symbol, analysis, index) {
    const row = document.createElement('tr');
    row.classList.add('fade-in');

    if (analysis.liveSignal === 'BUY')  row.classList.add('signal-active');
    if (analysis.liveSignal === 'SELL') row.classList.add('signal-short');
    if (parseFloat(analysis.winRate) > 50) row.classList.add('winner-row');

    const roiClass = parseFloat(analysis.roi) >= 0 ? 'pos' : 'neg';
    const wrClass  = parseFloat(analysis.winRate) >= 50 ? 'pos' : 'neg';

    const binanceUrl = `https://www.binance.com/es-LA/futures/${symbol}`;

    // Build pattern badges
    let patternBadges = '<span style="color:#474d57">—</span>';
    if (analysis.livePatterns) {
        const badges = [];
        for (const p of analysis.livePatterns.bullishPatterns) {
            badges.push(`<span class="badge-pattern badge-pattern-bull">${p.icon} ${p.name}</span>`);
        }
        for (const p of analysis.livePatterns.bearishPatterns) {
            badges.push(`<span class="badge-pattern badge-pattern-bear">${p.icon} ${p.name}</span>`);
        }
        if (badges.length > 0) {
            const scoreVal = analysis.livePatterns.score;
            const scoreClass = scoreVal > 0 ? 'score-pos' : scoreVal < 0 ? 'score-neg' : 'score-zero';
            patternBadges = badges.join(' ') + ` <span class="pattern-score ${scoreClass}">${scoreVal > 0 ? '+' : ''}${scoreVal}</span>`;
        }
    }

    // Determinar señal y badge
    let signalBadge, actionButtons;
    if (analysis.liveSignal === 'BUY') {
        signalBadge = `<span class="badge-signal badge-signal-buy">🟢 COMPRA</span>`;
        actionButtons = `<a href="${binanceUrl}" target="_blank" class="btn-action btn-buy" title="Abrir ${symbol} en Binance Futures para COMPRAR">🚀 Comprar</a>`;
    } else if (analysis.liveSignal === 'SELL') {
        signalBadge = `<span class="badge-signal badge-signal-sell">🔴 VENTA</span>`;
        actionButtons = `<a href="${binanceUrl}" target="_blank" class="btn-action btn-sell" title="Abrir ${symbol} en Binance Futures para VENDER">📉 Vender</a>`;
    } else {
        signalBadge = `<span class="badge-signal badge-signal-wait">⏳ ${analysis.currentTrend}</span>`;
        actionButtons = `<a href="${binanceUrl}" target="_blank" class="btn-action btn-view" title="Ver ${symbol} en Binance Futures">👁️ Ver</a>`;
    }

    row.innerHTML = `
        <td class="row-index">${index}</td>
        <td><b>${symbol}</b></td>
        <td class="${roiClass}">${analysis.roi}%</td>
        <td class="${wrClass}">${analysis.winRate}%</td>
        <td>${analysis.trades} <span class="trade-detail">(${analysis.wins}W / ${analysis.liquidations}💀 / ${analysis.unresolvedTrades}⏳)</span></td>
        <td class="patterns-cell">${patternBadges}</td>
        <td>${signalBadge}</td>
        <td class="action-cell">${actionButtons}</td>
    `;

    // Tooltip con info extra
    row.title = `Max Drawdown: ${analysis.maxDrawdown}% | Wins: ${analysis.wins} | Liquidaciones: ${analysis.liquidations} | Sin resolver: ${analysis.unresolvedTrades}`;

    DOM.tbody.appendChild(row);

    // Agregar event listener a todos los botones de acción
    const actionLink = row.querySelector('.btn-action');
    if (actionLink) {
        actionLink.addEventListener('click', (e) => {
            const action = analysis.liveSignal === 'BUY' ? 'COMPRAR' 
                         : analysis.liveSignal === 'SELL' ? 'VENDER' 
                         : 'VER';
            showLastAction(symbol, action, binanceUrl);
            markSelectedRow(row);
        });
    }
}

// ── Resumen ────────────────────────────────────
function updateSummary() {
    if (resultsData.length === 0) return;

    const buySignals  = resultsData.filter(r => r.liveSignal === 'BUY').length;
    const sellSignals = resultsData.filter(r => r.liveSignal === 'SELL').length;
    const bestROI     = resultsData.reduce((best, r) =>
        r.roiNum > best.roiNum ? r : best, resultsData[0]);

    DOM.sumTotal.textContent   = resultsData.length;
    DOM.sumBuy.textContent     = buySignals;
    DOM.sumSell.textContent    = sellSignals;

    // Mostrar "Mejor ROI" con contexto si es negativo
    const bestRoiValue = parseFloat(bestROI.roi);
    if (bestRoiValue >= 0) {
        DOM.sumBestROI.textContent = `${bestROI.symbol} (${bestROI.roi}%)`;
        DOM.sumBestROI.style.color = '';
    } else {
        DOM.sumBestROI.textContent = `${bestROI.symbol} (${bestROI.roi}%) ⚠️`;
        DOM.sumBestROI.title = 'Todos los pares tuvieron ROI negativo en el backtest';
        DOM.sumBestROI.style.color = '#ff6b6b';
    }

    // Cambiar la etiqueta del resumen según si hay ROI positivo o no
    const labelBestROI = DOM.sumBestROI.closest('.summary-card')?.querySelector('.summary-label');
    if (labelBestROI) {
        labelBestROI.textContent = bestRoiValue >= 0 ? 'Mejor ROI' : 'Menos Negativo';
    }

    DOM.summary.classList.remove('hidden');
}

// ── Ordenación de tabla ────────────────────────
let currentSort = { key: null, asc: true };

function sortTable(key) {
    if (currentSort.key === key) {
        currentSort.asc = !currentSort.asc;
    } else {
        currentSort.key = key;
        currentSort.asc = false; // descendente por defecto
    }

    const numKey = key === 'roi' ? 'roiNum' : key === 'winRate' ? 'winRateNum' : key;

    resultsData.sort((a, b) => {
        const va = typeof a[numKey] === 'number' ? a[numKey] : parseFloat(a[numKey]) || 0;
        const vb = typeof b[numKey] === 'number' ? b[numKey] : parseFloat(b[numKey]) || 0;
        return currentSort.asc ? va - vb : vb - va;
    });

    // Re-renderizar
    DOM.tbody.innerHTML = '';
    resultsData.forEach((r, i) => renderRow(r.symbol, r, i + 1));

    // Actualizar iconos
    document.querySelectorAll('th.sortable .sort-icon').forEach(icon => {
        icon.textContent = '⇅';
    });
    const activeIcon = document.querySelector(`th[data-sort="${key}"] .sort-icon`);
    if (activeIcon) activeIcon.textContent = currentSort.asc ? '↑' : '↓';
}

// ── UI Helpers ─────────────────────────────────
function setProgress(pct) {
    const p = Math.min(100, Math.max(0, Math.round(pct)));
    DOM.progressBar.style.width = p + '%';
    DOM.progressText.textContent = p + '%';
}

function toggleButton(scanning) {
    DOM.btnStart.disabled = scanning;
    DOM.btnText.textContent = scanning ? '⏳ Escaneando...' : '🔍 Escanear Mercado';
    DOM.btnStart.classList.toggle('scanning', scanning);
}

function showNotification(message, type = 'info') {
    DOM.status.textContent = (type === 'error' ? '❌ ' : 'ℹ️ ') + message;
    DOM.status.className = `status-box status-${type}`;
    setTimeout(() => { DOM.status.className = 'status-box'; }, 5000);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function showLastAction(symbol, action, url) {
    const lastActionEl = document.getElementById('lastAction');
    const lastActionText = document.getElementById('lastActionText');
    
    const timestamp = new Date().toLocaleTimeString('es-ES');
    const actionClass = action === 'COMPRAR' ? 'buy-action' 
                      : action === 'VENDER' ? 'sell-action' 
                      : 'view-action';
    const emoji = action === 'COMPRAR' ? '🚀' : action === 'VENDER' ? '📉' : '👁️';
    
    lastActionText.innerHTML = `
        <span class="${actionClass}">${emoji} ${action}</span> 
        <strong>${symbol}</strong> 
        <span class="action-time">a las ${timestamp}</span>
    `;
    
    lastActionEl.classList.remove('hidden');
    
    // Animación de entrada
    lastActionEl.style.animation = 'none';
    setTimeout(() => {
        lastActionEl.style.animation = 'slideIn 0.3s ease-out';
    }, 10);
}

function markSelectedRow(row) {
    // Remover marcado anterior
    document.querySelectorAll('tr.row-selected').forEach(r => {
        r.classList.remove('row-selected');
    });
    
    // Marcar la nueva fila
    row.classList.add('row-selected');
    
    // Scroll suave hacia la fila si está fuera de vista
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
