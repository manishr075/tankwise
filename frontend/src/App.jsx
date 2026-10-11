import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, Check, CloudRain, CloudOff, Database,
  Droplets, History, LoaderCircle, MapPin, RefreshCw, Save, ShieldCheck, Truck, Waves,
} from 'lucide-react';
import { DEFAULT_INPUTS, simulateWaterBalance, upcomingDates, validateInputs } from './engine.js';
import { API_BASE_URL, FORECAST_DAYS, apiRegion, apiRequest, fetchRainForecast } from './api.js';
import { dateAt, dayLabel, days, fmt, fmtOne, relativeDay, shortDate } from './format.js';

const HISTORY_KEY = 'tankwise-preview-history-v2';
const EXAMPLE_SOURCE = 'Example rainfall (not live)';
const REGION = apiRegion();

const STATUS_LABELS = {
  preview: 'Preview mode · no AWS configured',
  checking: 'Checking AWS…',
  connected: `AWS + DynamoDB connected${REGION ? ` · ${REGION}` : ''}`,
  degraded: 'AWS API reachable · DynamoDB unavailable',
  offline: 'AWS API offline',
  'local-mock': 'Local API mock · not AWS',
};

function readLocalHistory() {
  try {
    const entries = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(entries) ? entries.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function errorText(response, fallback) {
  return response?.data?.error || `${fallback} (HTTP ${response?.status ?? '—'})`;
}

function Field({ id, label, value, onChange, suffix, help, type = 'number', ...rest }) {
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      <span className="input-wrap">
        <input id={id} type={type} inputMode={type === 'number' ? 'decimal' : undefined} value={value}
          onChange={(event) => onChange(event.target.value)} aria-describedby={help ? `${id}-help` : undefined} {...rest} />
        {suffix && <span className="suffix" aria-hidden="true">{suffix}</span>}
      </span>
      {help && <span className="field-help" id={`${id}-help`}>{help}</span>}
    </div>
  );
}

function windowLabel(deadline, max) {
  if (deadline === null) return 'Now';
  if (deadline >= max) return `${max}+ days`;
  return relativeDay(deadline);
}

export default function App() {
  const initialDates = useRef(upcomingDates(7)).current;
  const [inputs, setInputs] = useState(DEFAULT_INPUTS);
  const [forecastDates, setForecastDates] = useState(initialDates);
  const [forecastSource, setForecastSource] = useState(EXAMPLE_SOURCE);
  const [plan, setPlan] = useState(() => ({
    inputs: DEFAULT_INPUTS,
    dates: initialDates,
    source: EXAMPLE_SOURCE,
    result: simulateWaterBalance(DEFAULT_INPUTS),
    calculatedBy: 'browser',
  }));
  const [apiStatus, setApiStatus] = useState(API_BASE_URL ? 'checking' : 'preview');
  const [lastCloud, setLastCloud] = useState(null);
  const [weather, setWeather] = useState({ state: 'idle', message: '' });
  const [busyCalculate, setBusyCalculate] = useState(false);
  const [busySave, setBusySave] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [history, setHistory] = useState(() => (API_BASE_URL ? [] : readLocalHistory()));
  const [historyState, setHistoryState] = useState(API_BASE_URL ? 'idle' : 'browser');
  const [activeTab, setActiveTab] = useState('forecast');
  const calcSeq = useRef(0);
  const calcAbort = useRef(null);

  const cloudReady = apiStatus === 'connected' || apiStatus === 'local-mock';
  const update = (key, value) => setInputs((prev) => ({ ...prev, [key]: value }));
  const inputsAreDirty = JSON.stringify(inputs) !== JSON.stringify(plan.inputs);

  const recordCloud = (method, path, response, extra = '') => {
    setLastCloud({ method, path, status: response?.status ?? 'network error', ms: response?.ms, extra, at: new Date() });
  };

  const loadHistory = useCallback(async (buildingName, ready) => {
    if (!ready) {
      setHistory(readLocalHistory());
      setHistoryState('browser');
      return;
    }
    setHistoryState('loading');
    const path = `/history?building_id=${encodeURIComponent((buildingName || '').trim() || 'default')}`;
    try {
      const response = await apiRequest(path);
      recordCloud('GET', '/history', response, response.ok ? `${response.data?.items?.length ?? 0} records` : '');
      if (!response.ok) throw new Error(errorText(response, 'History request failed'));
      setHistory(Array.isArray(response.data?.items) ? response.data.items : []);
      setHistoryState('cloud');
    } catch (historyError) {
      setHistoryState('error');
      setError(`Could not load saved history from AWS: ${historyError.message}`);
    }
  }, []);

  // Runs the model via AWS Lambda when connected, otherwise in the browser.
  const calculate = useCallback(async (nextInputs, { dates, source, ready, quiet = false } = {}) => {
    // Newer calculations supersede older ones: abort the in-flight request and ignore late replies.
    const seq = calcSeq.current + 1;
    calcSeq.current = seq;
    calcAbort.current?.abort();
    const controller = new AbortController();
    calcAbort.current = controller;
    const isCurrent = () => seq === calcSeq.current;
    setBusyCalculate(true);
    setError('');
    if (!quiet) setNotice('');
    try {
      const localResult = simulateWaterBalance(nextInputs); // validates instantly with the same rules as Lambda
      let result = localResult;
      let calculatedBy = 'browser';
      if (ready) {
        try {
          const response = await apiRequest('/simulate', { method: 'POST', body: nextInputs, signal: controller.signal });
          if (!isCurrent()) return false;
          recordCloud('POST', '/simulate', response, response.ok ? 'calculated by Lambda' : '');
          if (response.status === 400) throw Object.assign(new Error(errorText(response, 'Invalid input')), { validation: true });
          if (!response.ok || !response.data?.result) throw new Error(errorText(response, 'Simulation failed'));
          result = response.data.result;
          calculatedBy = response.data.calculatedBy === 'aws-lambda' ? 'aws-lambda' : 'local-mock';
        } catch (cloudError) {
          if (!isCurrent()) return false;
          if (cloudError.validation) throw cloudError;
          setApiStatus('offline');
          setNotice(`AWS calculation failed (${cloudError.message}). Showing the browser calculation instead; saves are browser-only until AWS reconnects.`);
        }
      }
      if (!isCurrent()) return false;
      setPlan({ inputs: nextInputs, dates, source, result, calculatedBy });
      return true;
    } catch (calculationError) {
      if (!isCurrent()) return false;
      setError(`${calculationError.message || 'Could not calculate this scenario.'} The plan below still shows the last valid calculation.`);
      return false;
    } finally {
      if (isCurrent()) setBusyCalculate(false);
    }
  }, []);

  const checkHealth = useCallback(async (planForRecalc) => {
    if (!API_BASE_URL) return;
    setApiStatus('checking');
    try {
      const response = await apiRequest('/health', { timeoutMs: 8000 });
      recordCloud('GET', '/health', response, response.data?.storage ? `storage: ${response.data.storage}` : '');
      const storage = response.data?.storage;
      let status = 'degraded';
      if (response.ok && storage === 'dynamodb') status = 'connected';
      else if (response.ok && storage === 'local-mock') status = 'local-mock';
      setApiStatus(status);
      const ready = status === 'connected' || status === 'local-mock';
      await loadHistory(planForRecalc.inputs.buildingName, ready);
      if (ready) await calculate(planForRecalc.inputs, { dates: planForRecalc.dates, source: planForRecalc.source, ready, quiet: true });
    } catch {
      setApiStatus('offline');
      setHistory(readLocalHistory());
      setHistoryState('browser');
    }
  }, [calculate, loadHistory]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { checkHealth(plan); }, []);

  const recalculate = (event) => {
    event?.preventDefault();
    calculate(inputs, { dates: forecastDates, source: forecastSource, ready: cloudReady });
  };

  const loadWeather = async () => {
    setError('');
    setNotice('');
    const latitude = Number(inputs.latitude);
    const longitude = Number(inputs.longitude);
    if (String(inputs.latitude).trim() === '' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      setError('Latitude must be a number between -90 and 90.');
      return;
    }
    if (String(inputs.longitude).trim() === '' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      setError('Longitude must be a number between -180 and 180.');
      return;
    }
    setWeather({ state: 'loading', message: 'Contacting Open-Meteo…' });
    try {
      const forecast = await fetchRainForecast(latitude, longitude);
      const fetchedAt = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      const source = `Open-Meteo live forecast · ${latitude.toFixed(2)}, ${longitude.toFixed(2)} · fetched ${fetchedAt}`;
      const nextInputs = { ...inputs, forecastMm: forecast.rainfallMm };
      setInputs(nextInputs);
      setForecastDates(forecast.dates);
      setForecastSource(source);
      const total = forecast.rainfallMm.reduce((sum, mm) => sum + mm, 0);
      setWeather({
        state: 'ok',
        message: `Loaded ${forecast.dates.length}-day forecast (${fmtOne(total)} mm total)`
          + (forecast.dates.length < FORECAST_DAYS ? `; Open-Meteo returned fewer than ${FORECAST_DAYS} days, so later days count as 0 mm` : '')
          + (forecast.missingDays ? `; ${forecast.missingDays} missing day(s) treated as 0 mm` : '') + '.',
      });
      await calculate(nextInputs, { dates: forecast.dates, source, ready: cloudReady });
    } catch (weatherError) {
      setWeather({ state: 'error', message: `Live forecast unavailable: ${weatherError.message}. Still using: ${forecastSource}.` });
    }
  };

  const saveDecision = async () => {
    if (inputsAreDirty) return;
    setBusySave(true);
    setError('');
    setNotice('');
    const record = {
      building_id: (plan.inputs.buildingName || '').trim().slice(0, 80) || 'default',
      input: plan.inputs,
      forecast_source: plan.source,
      forecast_dates: plan.dates,
    };
    try {
      if (cloudReady) {
        let response;
        try {
          response = await apiRequest('/records', { method: 'POST', body: record });
        } catch (networkError) {
          recordCloud('POST', '/records', null);
          throw new Error(`${networkError.message}. Nothing was saved.`);
        }
        recordCloud('POST', '/records', response, response.ok ? `record ${String(response.data?.item?.record_id || '').slice(0, 8)}` : '');
        if (!response.ok) throw new Error(`${errorText(response, 'Save failed')}. Nothing was saved.`);
        setNotice(`Saved to ${apiStatus === 'local-mock' ? 'the local API mock (not AWS)' : 'Amazon DynamoDB'} at ${new Date(response.data.item.created_at).toLocaleTimeString('en-IN')} · record ${response.data.item.record_id.slice(0, 8)}. Lambda recalculated the result before saving.`);
        await loadHistory(plan.inputs.buildingName, true);
      } else {
        const localRecord = {
          ...record, output: plan.result, created_at: new Date().toISOString(),
          record_id: `local-${Date.now()}`, storage: 'browser',
        };
        const nextHistory = [localRecord, ...readLocalHistory()].slice(0, 8);
        localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory));
        setHistory(nextHistory);
        setHistoryState('browser');
        setNotice('Saved in this browser only (localStorage). This is not an AWS save.');
      }
    } catch (saveError) {
      setError(`Save failed: ${saveError.message}`);
    } finally {
      setBusySave(false);
    }
  };

  const loadScenario = (record) => {
    const savedInputs = { ...DEFAULT_INPUTS, ...(record.input || {}) };
    const savedDates = Array.isArray(record.forecast_dates) && record.forecast_dates.length ? record.forecast_dates : upcomingDates(7, new Date(record.created_at || Date.now()));
    const source = `Saved plan · ${record.forecast_source || 'unknown source'}`;
    setInputs(savedInputs);
    setForecastDates(savedDates);
    setForecastSource(source);
    try {
      const result = record.output || simulateWaterBalance(savedInputs);
      setPlan({ inputs: savedInputs, dates: savedDates, source, result, calculatedBy: record.calculated_by || 'browser' });
      setNotice(`Showing the saved plan from ${new Date(record.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}. Dates are relative to that save. Load a live forecast to plan for today.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (loadError) {
      setError(`Could not open this saved plan: ${loadError.message}`);
    }
  };

  const resetInputs = () => {
    const dates = upcomingDates(7);
    setInputs(DEFAULT_INPUTS);
    setForecastDates(dates);
    setForecastSource(EXAMPLE_SOURCE);
    setWeather({ state: 'idle', message: '' });
    calculate(DEFAULT_INPUTS, { dates, source: EXAMPLE_SOURCE, ready: cloudReady });
  };

  const { result } = plan;
  const max = result.maxOrderWindowDays;
  const fd = result.forecastDeadlineDays;
  const nd = result.noRainDeadlineDays;
  const stock = Number(plan.inputs.currentStockLiters);
  const capacity = Number(plan.inputs.tankCapacityLiters);
  const safety = Number(plan.inputs.safetyStockLiters);
  const lead = Number(plan.inputs.leadTimeDays);
  const dateText = (offset) => shortDate(dateAt(plan.dates, offset));
  const headline = fd === null ? 'Book a tanker now and arrange backup water.'
    : fd === 0 ? 'Book the next tanker today.'
      : fd >= max ? `No booking needed for at least ${max} days.`
        : `Book the next tanker by ${dateText(fd)}.`;
  const rainGain = fd !== null && nd !== null ? fd - nd : null;
  const urgencyLabel = { critical: 'Supply risk', high: 'Book soon', planned: 'Planning window' }[result.urgency];
  const UrgencyIcon = result.urgency === 'planned' ? ShieldCheck : AlertTriangle;
  const breachText = (day) => (day === null ? `not within ${result.horizonDays} days` : `${dayLabel(plan.dates, day - 1)}`);
  const timeline = activeTab === 'forecast' ? result.forecastTimeline : result.noRainTimeline;
  const tabDeadline = activeTab === 'forecast' ? fd : nd;
  const arrivalIndex = (tabDeadline ?? 0) + lead;
  const saveLabel = cloudReady
    ? (apiStatus === 'local-mock' ? 'Saves to local API mock (not AWS)' : 'Saves to Amazon DynamoDB via API Gateway + Lambda')
    : apiStatus === 'checking' ? 'Waiting for AWS check…' : 'Browser-only save · not AWS';

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Tankwise home">
          <span className="brand-mark"><Waves size={20} strokeWidth={2.4} aria-hidden="true" /></span>
          <span className="brand-text"><span className="brand-name">tankwise</span><small>Tanker booking, rain-aware</small></span>
        </a>
        <div className="topbar-right">
          <button type="button" className={`connection-chip ${apiStatus}`} onClick={() => checkHealth(plan)}
            disabled={!API_BASE_URL || apiStatus === 'checking'} title={API_BASE_URL ? 'Re-check the AWS connection' : 'Set VITE_API_BASE_URL to connect AWS'}
            aria-live="polite">
            {apiStatus === 'checking' ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : apiStatus === 'offline' ? <CloudOff size={13} aria-hidden="true" /> : <span className="connection-dot" aria-hidden="true" />}
            {STATUS_LABELS[apiStatus]}
          </button>
          <button type="button" className="button button-quiet button-small" onClick={resetInputs}><RefreshCw size={14} aria-hidden="true" /> Reset example</button>
        </div>
      </header>

      <main id="top" className="page">
        <section className="intro">
          <p><strong>When should this building book its next water tanker?</strong> Tankwise projects the tank day by day from stock, daily use, supplier lead time and roof rain capture, and always shows what happens if the forecast rain does not come.</p>
          <div className="intro-meta">
            <span><MapPin size={13} aria-hidden="true" /> {plan.inputs.buildingName || 'Unnamed building'}</span>
            <span className={plan.source.startsWith('Open-Meteo') ? 'live' : 'not-live'}><CloudRain size={13} aria-hidden="true" /> {plan.source}</span>
          </div>
        </section>

        {error && <div className="alert alert-error" role="alert"><AlertTriangle size={17} aria-hidden="true" /><span>{error}</span><button type="button" onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
        {notice && <div className="alert alert-info" role="status"><Check size={16} aria-hidden="true" /><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="Dismiss message">×</button></div>}

        <section className={`panel decision-panel ${result.urgency}`} aria-labelledby="decision-heading">
          {inputsAreDirty && <div className="dirty-note" role="status"><Activity size={14} aria-hidden="true" /> Inputs changed. These numbers are for the previous inputs. Press <b>Recalculate</b> to update them.</div>}
          <div className="decision-topline">
            <span className={`urgency-tag ${result.urgency}`}><UrgencyIcon size={14} aria-hidden="true" /> {urgencyLabel}</span>
            <span className="calc-by" role="status">{busyCalculate ? 'Recalculating…' : plan.calculatedBy === 'aws-lambda' ? `Calculated by AWS Lambda${REGION ? ` (${REGION})` : ''}` : plan.calculatedBy === 'local-mock' ? 'Calculated by local API mock (not AWS)' : 'Calculated in this browser'}</span>
          </div>
          <h1 id="decision-heading">{headline}</h1>
          <p className="decision-copy">{result.recommendation}</p>

          <div className="kpi-grid">
            <div className="kpi">
              <span className="kpi-label"><Droplets size={14} aria-hidden="true" /> Water in tank now</span>
              <strong>{fmt(stock)} <small>L</small></strong>
              <span className="kpi-detail">{Math.round((100 * stock) / Math.max(1, capacity))}% of {fmt(capacity)} L · uses {fmt(plan.inputs.dailyConsumptionLiters)} L/day</span>
            </div>
            <div className="kpi kpi-primary">
              <span className="kpi-label"><CloudRain size={14} aria-hidden="true" /> Latest booking day · with forecast rain</span>
              <strong>{fd === null ? 'Now' : fd >= max ? `${max}+ days` : dateText(fd)}</strong>
              <span className="kpi-detail">{fd === null ? 'Buffer already at risk' : `${windowLabel(fd, max)} · arrives ${dateText(fd + lead)} (${days(lead)} lead time)`}</span>
            </div>
            <div className="kpi kpi-stress">
              <span className="kpi-label"><AlertTriangle size={14} aria-hidden="true" /> If no rain falls</span>
              <strong>{nd === null ? 'Now' : nd >= max ? `${max}+ days` : dateText(nd)}</strong>
              <span className="kpi-detail">{nd === null ? 'Book now + backup supply' : `${windowLabel(nd, max)} · stress test`}{rainGain > 0 ? ` · rain buys ${days(rainGain)}` : ''}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label"><Truck size={14} aria-hidden="true" /> Estimated top-up to target stock</span>
              <strong>{fmt(result.estimatedTopUpLiters)} <small>L</small></strong>
              <span className="kpi-detail">To reach {fmt(result.targetStockLiters)} L if delivered {dateText(result.forecastArrivalDay)}. No rain: {fmt(result.noRainEstimatedTopUpLiters)} L. Not a tanker size.</span>
            </div>
          </div>

          <div className={`risk-strip ${result.hasSupplyRiskBeforeDelivery || result.noRainFirstBelowSafetyDay ? 'risk-high' : ''}`}>
            {result.hasSupplyRiskBeforeDelivery ? <AlertTriangle size={17} aria-hidden="true" /> : <ShieldCheck size={17} aria-hidden="true" />}
            <div>
              <strong>Without a tanker, stock falls below the {fmt(safety)} L safety buffer: {breachText(result.forecastFirstBelowSafetyDay)} with forecast rain, {breachText(result.noRainFirstBelowSafetyDay)} with no rain.</strong>
              <span>Forecast rain could add up to {fmt(result.forecastPotentialCaptureLiters)} L over {result.horizonDays} days{result.forecastOverflowLiters > 0 ? ` (${fmt(result.forecastOverflowLiters)} L would overflow)` : ''}. Rain is uncertain and collected rain is not assumed drinkable. Use the no-rain date if running short is unacceptable.</span>
            </div>
          </div>

          <div className="decision-actions">
            <button type="button" className="button button-primary" onClick={saveDecision} disabled={busySave || inputsAreDirty || apiStatus === 'checking'}>
              {busySave ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Save size={16} aria-hidden="true" />}{busySave ? 'Saving…' : 'Save this decision'}
            </button>
            <span className={`save-state ${cloudReady ? 'cloud' : ''}`}><Database size={14} aria-hidden="true" /> {inputsAreDirty ? 'Recalculate before saving' : saveLabel}</span>
          </div>
          {lastCloud && <p className="cloud-log" aria-live="polite"><span>Last API call</span> {lastCloud.method} {lastCloud.path} → {lastCloud.status}{lastCloud.ms !== undefined ? ` in ${lastCloud.ms} ms` : ''}{lastCloud.extra ? ` · ${lastCloud.extra}` : ''} · {lastCloud.at.toLocaleTimeString('en-IN')}{apiStatus !== 'local-mock' && REGION ? ` · execute-api.${REGION}` : ''}</p>}
        </section>

        <section className="workspace-grid">
          <form className="panel inputs-panel" onSubmit={recalculate} noValidate aria-labelledby="setup-heading">
            <div className="section-kicker">Your building</div>
            <h2 id="setup-heading">Water setup</h2>
            <Field id="buildingName" label="Building / property name" type="text" maxLength={80} value={inputs.buildingName} onChange={(v) => update('buildingName', v)} help="Saved plans are grouped by this name." />
            <div className="field-row">
              <Field id="currentStock" label="Water in tank now" value={inputs.currentStockLiters} min="0" step="any" onChange={(v) => update('currentStockLiters', v)} suffix="L" />
              <Field id="capacity" label="Tank capacity" value={inputs.tankCapacityLiters} min="1" step="any" onChange={(v) => update('tankCapacityLiters', v)} suffix="L" />
            </div>
            <Field id="consumption" label="Daily water use" value={inputs.dailyConsumptionLiters} min="1" step="any" onChange={(v) => update('dailyConsumptionLiters', v)} suffix="L/day" help="A recent daily average." />
            <div className="field-row">
              <Field id="roof" label="Roof catchment area" value={inputs.roofAreaM2} min="0" step="any" onChange={(v) => update('roofAreaM2', v)} suffix="m²" />
              <Field id="efficiency" label="Collection efficiency" value={inputs.collectionEfficiency} min="0" max="1" step="0.05" onChange={(v) => update('collectionEfficiency', v)} suffix="0–1" help="0.8 = 80% reaches the tank." />
            </div>
            <div className="field-row">
              <Field id="lead" label="Supplier lead time" value={inputs.leadTimeDays} min="0" max="14" step="1" onChange={(v) => update('leadTimeDays', v)} suffix="days" help="0 = same-day delivery." />
              <Field id="safety" label="Safety stock to keep" value={inputs.safetyStockLiters} min="0" step="any" onChange={(v) => update('safetyStockLiters', v)} suffix="L" help="Never plan below this." />
            </div>
            <fieldset className="forecast-box">
              <legend><MapPin size={14} aria-hidden="true" /> Rain forecast location</legend>
              <div className="field-row">
                <Field id="latitude" label="Latitude" value={inputs.latitude} step="any" min="-90" max="90" onChange={(v) => update('latitude', v)} />
                <Field id="longitude" label="Longitude" value={inputs.longitude} step="any" min="-180" max="180" onChange={(v) => update('longitude', v)} />
              </div>
              <button type="button" className="button button-secondary button-full" onClick={loadWeather} disabled={weather.state === 'loading' || busyCalculate}>
                {weather.state === 'loading' ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <CloudRain size={16} aria-hidden="true" />}
                {weather.state === 'loading' ? 'Loading forecast…' : 'Load live 14-day rainfall'}
              </button>
              <p className={`inline-status ${weather.state}`} role="status">{weather.message || `Using: ${forecastSource}`}</p>
              <p className="subtle-note">Daily precipitation from Open-Meteo (14-day forecast). Days beyond day 14 count as 0 mm.</p>
            </fieldset>
            <button type="submit" className="button button-primary button-full" disabled={busyCalculate}>
              {busyCalculate ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Activity size={16} aria-hidden="true" />}
              {busyCalculate ? 'Calculating…' : 'Recalculate water plan'}
            </button>
          </form>

          <div className="analysis-column">
            <section className="panel timeline-panel" aria-labelledby="timeline-heading">
              <div className="panel-heading">
                <div><div className="section-kicker">Day-by-day water balance · no tanker ordered</div><h2 id="timeline-heading">Tank level each evening</h2></div>
                <div className="tabs" role="group" aria-label="Rain scenario">
                  <button type="button" className={activeTab === 'forecast' ? 'active' : ''} aria-pressed={activeTab === 'forecast'} onClick={() => setActiveTab('forecast')}>With forecast rain</button>
                  <button type="button" className={activeTab === 'norain' ? 'active' : ''} aria-pressed={activeTab === 'norain'} onClick={() => setActiveTab('norain')}>No-rain stress test</button>
                </div>
              </div>
              <ol className="timeline-list">
                {timeline.map((day, index) => {
                  const stockPercent = Math.max(0, Math.min(100, (day.stockAfterLiters / Math.max(1, capacity)) * 100));
                  const reservePercent = Math.max(0, Math.min(100, (safety / Math.max(1, capacity)) * 100));
                  const risk = day.shortageLiters > 0 || day.stockAfterLiters < safety;
                  return (
                    <li className={`timeline-row ${risk ? 'row-risk' : ''}`} key={`${activeTab}-${day.day}`}>
                      <div className="timeline-day">
                        <strong>{dayLabel(plan.dates, index)}</strong>
                        <span>{fmtOne(day.rainfallMm)} mm rain</span>
                        {tabDeadline !== null && index === tabDeadline && tabDeadline < max && <em className="badge badge-book">Last day to book</em>}
                        {index === arrivalIndex && tabDeadline !== null && tabDeadline < max && <em className="badge badge-arrive">Tanker arrives</em>}
                      </div>
                      <div className="level-track" role="img" aria-label={`${fmt(day.stockAfterLiters)} litres at end of day`}>
                        <div className="level-fill" style={{ width: `${stockPercent}%` }} />
                        <div className="reserve-marker" style={{ left: `${reservePercent}%` }} />
                        <span className="level-label">{fmt(day.stockAfterLiters)} L</span>
                      </div>
                      <div className="day-impact">
                        <span className="demand-impact"><ArrowDownRight size={13} aria-hidden="true" /> {day.demandLiters - day.shortageLiters > 0 ? `−${fmt(day.demandLiters - day.shortageLiters)} L used` : 'tank empty'}</span>
                        {day.potentialHarvestLiters > 0 && <span className="rain-impact"><ArrowUpRight size={13} aria-hidden="true" /> +{fmt(day.potentialHarvestLiters)} L rain</span>}
                        {day.overflowLiters > 0 && <span className="overflow-impact">{fmt(day.overflowLiters)} L overflow</span>}
                        {day.shortageLiters > 0 && <span className="shortage-impact">{fmt(day.shortageLiters)} L short</span>}
                      </div>
                    </li>
                  );
                })}
              </ol>
              <div className="chart-foot">
                <span><i className="reserve-key" aria-hidden="true" /> Safety stock {fmt(safety)} L</span>
                <span><i className="risk-key" aria-hidden="true" /> Below safety stock or short</span>
                <span>Each day: use first, then add rain, capped at {fmt(capacity)} L.</span>
              </div>
            </section>

            <section className="panel method-panel" aria-labelledby="method-heading">
              <div className="section-kicker">Show your work</div>
              <h2 id="method-heading">How this recommendation is calculated</h2>
              <ol className="formula-grid">
                <li><strong>Rain capture</strong><p>{fmtOne(result.forecastTimeline.reduce((t, d) => t + d.rainfallMm, 0))} mm × {fmt(plan.inputs.roofAreaM2)} m² × {fmtOne(Number(plan.inputs.collectionEfficiency) * 100)}% = <b>{fmt(result.forecastPotentialCaptureLiters)} L</b> potential. 1 mm on 1 m² = 1 L before losses.</p></li>
                <li><strong>Daily balance</strong><p>Subtract {fmt(plan.inputs.dailyConsumptionLiters)} L use, then add rain capture, cap at {fmt(capacity)} L. Overflow and unmet demand are tracked separately; stock never goes below 0.</p></li>
                <li><strong>Latest booking day</strong><p>The last day you can order so that, with a {days(lead)} lead time, every day until the tanker arrives ends at or above {fmt(safety)} L. Deliveries arrive before that day's use. Checked up to {max} days ahead.</p></li>
                <li><strong>Estimated top-up</strong><p>Target = safety stock + 2 days of use ({fmt(result.targetStockLiters)} L, capped at capacity) minus projected stock on arrival. Real tanker sizes and minimum orders are not modelled.</p></li>
              </ol>
            </section>
          </div>
        </section>

        <section className="panel history-panel" aria-labelledby="history-heading">
          <div className="panel-heading">
            <div>
              <div className="section-kicker">Decision log</div>
              <h2 id="history-heading">Saved decisions {historyState === 'cloud' ? (apiStatus === 'local-mock' ? '· local API mock (not AWS)' : '· Amazon DynamoDB') : historyState === 'browser' ? '· this browser only' : ''}</h2>
              <p className="panel-description">Logs what was recommended and the exact inputs. It does not yet record deliveries or measure water saved.</p>
            </div>
            <button type="button" className="button button-quiet button-small" onClick={() => loadHistory(plan.inputs.buildingName, cloudReady)} disabled={historyState === 'loading'}>
              {historyState === 'loading' ? <LoaderCircle className="spin" size={14} aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Refresh
            </button>
          </div>
          {historyState === 'loading' && history.length === 0 ? <p className="subtle-note">Loading saved decisions…</p>
            : history.length === 0 ? <div className="empty-history"><History size={20} aria-hidden="true" /><div><strong>No decisions saved yet{cloudReady ? ` for “${plan.inputs.buildingName || 'default'}”` : ''}</strong><p>{cloudReady ? 'Press “Save this decision” to write the first record.' : 'Saves stay in this browser until the AWS API is connected.'}</p></div></div>
              : <ul className="history-list">{history.map((record) => {
                const out = record.output || {};
                const rIn = record.input || {};
                const dates = record.forecast_dates?.length ? record.forecast_dates : upcomingDates(7, new Date(record.created_at));
                const deadlineText = (value) => (value === null || value === undefined ? 'Now' : value >= max ? `${max}+ days` : dayLabel(dates, value));
                const forecastBy = deadlineText(out.forecastDeadlineDays);
                const noRainBy = deadlineText(out.noRainDeadlineDays);
                return (
                  <li key={record.record_id || record.created_at}>
                    <button type="button" className="history-item" onClick={() => loadScenario(record)}>
                      <span className={`storage-badge ${record.storage === 'browser' ? 'browser' : 'cloud'}`}>{{ browser: 'Browser', 'local-mock': 'Local mock' }[record.storage] || 'DynamoDB'}</span>
                      <span className="history-main"><strong>{record.building_id || rIn.buildingName || 'Saved plan'}</strong><small>{new Date(record.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })} · {String(record.forecast_source || '').split(' · ')[0]}</small></span>
                      <span className="history-figures">
                        <b>{fmt(out.estimatedTopUpLiters)} L top-up</b>
                        <span className="history-dates">Book by {forecastBy} · no rain {noRainBy}</span>
                      </span>
                    </button>
                  </li>
                );
              })}</ul>}
        </section>

        <section className="limitations">
          <ShieldCheck size={17} aria-hidden="true" />
          <p><strong>Decision support, not a guarantee.</strong> Example values are not measured building data. Forecast rain can fail, tank readings can be wrong, and Tankwise does not judge whether collected water is safe to drink. Keep a backup supply for essential needs.</p>
        </section>
      </main>
      <footer className="footer"><span>tankwise · hackathon prototype</span><span>{STATUS_LABELS[apiStatus]}</span></footer>
    </div>
  );
}
