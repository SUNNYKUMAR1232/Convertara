'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { LlmConfig, ProviderInfo } from '@/lib/api';

interface Draft {
  id?: string;
  label: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  temperature: number;
  fallbackModel: string;
  isDefault: boolean;
}

const EMPTY: Draft = {
  label: 'Default',
  provider: 'anthropic',
  model: '',
  baseUrl: '',
  apiKey: '',
  temperature: 0.1,
  fallbackModel: '',
  isDefault: true,
};

export function SettingsPanel() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [secretsConfigured, setSecretsConfigured] = useState(true);
  const [serverDefault, setServerDefault] = useState<{ provider: string; model: string } | null>(null);
  const [configs, setConfigs] = useState<LlmConfig[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<{ kind: 'ok' | 'bad' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useRef<HTMLDivElement>(null);

  const info = providers.find((p) => p.provider === draft.provider);

  useEffect(() => {
    void reload();
  }, []);

  async function reload() {
    try {
      const [meta, saved] = await Promise.all([api.providers(), api.llmConfigs()]);
      setProviders(meta.providers);
      setSecretsConfigured(meta.secretsConfigured);
      setServerDefault(meta.serverDefault);
      setConfigs(saved.configs);
      if (meta.providers[0] && draft.model === '') {
        const first = meta.providers.find((p) => p.provider === draft.provider) ?? meta.providers[0];
        setDraft((d) => ({ ...d, provider: first.provider, model: first.suggestedModels[0] ?? '' }));
      }
    } catch (error) {
      setStatus({ kind: 'bad', text: (error as Error).message });
    }
  }

  function pickProvider(provider: string) {
    const chosen = providers.find((p) => p.provider === provider);
    setModels([]);
    setDraft((d) => ({
      ...d,
      provider,
      model: chosen?.suggestedModels[0] ?? '',
      baseUrl: '',
    }));
  }

  function payload() {
    return {
      ...(draft.id ? { id: draft.id } : {}),
      label: draft.label,
      provider: draft.provider,
      model: draft.model,
      ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      temperature: draft.temperature,
      ...(draft.fallbackModel ? { fallbackModel: draft.fallbackModel } : {}),
      isDefault: draft.isDefault,
    };
  }

  async function test() {
    setBusy(true);
    setStatus({ kind: 'info', text: 'Contacting the provider…' });
    try {
      const result = await api.testLlm({
        // The stored key never comes back to this page, so when the key box is
        // empty the server has to read it from the saved configuration.
        ...(draft.id ? { configId: draft.id } : {}),
        provider: draft.provider,
        model: draft.model,
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        temperature: draft.temperature,
      });
      setStatus(
        result.ok
          ? { kind: 'ok', text: `Connected to ${result.model} in ${result.latencyMs} ms.` }
          : { kind: 'bad', text: result.error ?? 'Connection failed' },
      );
    } catch (error) {
      setStatus({ kind: 'bad', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function loadModels() {
    setBusy(true);
    try {
      const result = await api.listModels({
        ...(draft.id ? { configId: draft.id } : {}),
        provider: draft.provider,
        model: draft.model || 'placeholder',
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      });
      setModels(result.models);
      if (result.models.length === 0) {
        setStatus({ kind: 'info', text: result.error ?? 'This provider did not return a model list.' });
      }
    } catch (error) {
      setStatus({ kind: 'bad', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    setBusy(true);
    try {
      await api.saveLlmConfig(payload());
      setStatus({ kind: 'ok', text: 'Saved. New requests will use this model.' });
      setDraft((d) => ({ ...d, apiKey: '' }));
      await reload();
    } catch (error) {
      setStatus({ kind: 'bad', text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel" ref={form}>
        <h2>
          {draft.id ? `Editing ${draft.label}` : 'Language model'}
          <span className="sub">used only when a request is too vague for the rules engine</span>
        </h2>

        {!secretsConfigured && (
          <div className="alert warn" style={{ marginBottom: 14 }}>
            SECRET_KEY is not set on the server, so API keys cannot be stored. Generate one with{' '}
            <code>openssl rand -hex 32</code> and restart.
          </div>
        )}

        {serverDefault && (
          <div className="alert info" style={{ marginBottom: 14 }}>
            Server default: {serverDefault.provider} / {serverDefault.model}. Anything saved here overrides it.
          </div>
        )}

        <div className="two">
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select id="provider" value={draft.provider} onChange={(event) => pickProvider(event.target.value)}>
              {providers.map((provider) => (
                <option key={provider.provider} value={provider.provider}>
                  {provider.label}
                </option>
              ))}
            </select>
            {info && <p className="hint">{info.help}</p>}
          </div>

          <div className="field">
            <label htmlFor="model">Model</label>
            <input
              id="model"
              type="text"
              list="model-options"
              value={draft.model}
              placeholder={info?.suggestedModels[0] ?? 'model name'}
              onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            />
            <datalist id="model-options">
              {[...new Set([...(info?.suggestedModels ?? []), ...models])].map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
            <p className="hint">
              Any model string works.{' '}
              <button type="button" className="chip" onClick={() => void loadModels()} disabled={busy}>
                Fetch list from provider
              </button>
            </p>
          </div>
        </div>

        <div className="two">
          <div className="field">
            <label htmlFor="apiKey">API key</label>
            <input
              id="apiKey"
              type="password"
              value={draft.apiKey}
              autoComplete="off"
              placeholder={info?.requiresApiKey ? 'required' : 'not needed for this provider'}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <p className="hint">Encrypted before storage and never sent back to this page.</p>
          </div>

          <div className="field">
            <label htmlFor="baseUrl">Base URL</label>
            <input
              id="baseUrl"
              type="text"
              value={draft.baseUrl}
              placeholder={info?.defaultBaseUrl ?? ''}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
            <p className="hint">Leave empty for the default endpoint.</p>
          </div>
        </div>

        <div className="two">
          <div className="field">
            <label htmlFor="fallback">Fallback model</label>
            <input
              id="fallback"
              type="text"
              value={draft.fallbackModel}
              placeholder="used if the primary is rate limited"
              onChange={(event) => setDraft({ ...draft, fallbackModel: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="temperature">Temperature</label>
            <input
              id="temperature"
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={draft.temperature}
              onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })}
            />
            <p className="hint">Low is better for planning. Ignored by providers that removed sampling controls.</p>
          </div>
        </div>

        <div className="row" style={{ marginTop: 4 }}>
          <button onClick={() => void test()} disabled={busy || draft.model === ''} className="ghost">
            Test connection
          </button>
          <button onClick={() => void save()} disabled={busy || draft.model === ''}>
            {draft.id ? 'Save changes' : 'Save'}
          </button>
          {draft.id && (
            <button
              className="ghost"
              onClick={() => {
                setDraft(EMPTY);
                setStatus(null);
              }}
            >
              Cancel
            </button>
          )}
        </div>

        {status && (
          <div className={`alert ${status.kind}`} style={{ marginTop: 12 }}>
            {status.text}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Saved configurations</h2>
        {configs.length === 0 ? (
          <p className="muted">
            None yet. Without one, Convertara still handles any request the rules engine understands — conversion,
            resizing, size targets, merging, zipping.
          </p>
        ) : (
          <div className="results">
            {configs.map((config) => (
              <div className="result" key={config.id}>
                <span className="name">
                  {config.label} — {config.provider}/{config.model}
                  {config.isDefault && <span className="badge ok" style={{ marginLeft: 8 }}>default</span>}
                </span>
                <span className="meta">{config.apiKeyHint ?? 'no key'}</span>
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => {
                    // The form sits above this list, so without scrolling to it
                    // and saying what is being edited, clicking Edit looks like
                    // it did nothing at all.
                    setDraft({
                      id: config.id,
                      label: config.label,
                      provider: config.provider,
                      model: config.model,
                      baseUrl: config.baseUrl ?? '',
                      apiKey: '',
                      temperature: config.temperature,
                      fallbackModel: config.fallbackModel ?? '',
                      isDefault: config.isDefault,
                    });
                    setStatus({ kind: 'info', text: `Editing "${config.label}". Save to apply your changes.` });
                    form.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost small"
                  onClick={async () => {
                    // Whatever happens, re-read the list afterwards. A delete
                    // that throws used to skip the refresh entirely, leaving a
                    // row for a configuration the server no longer has and no
                    // message to explain it.
                    try {
                      await api.deleteLlmConfig(config.id);
                      setStatus({ kind: 'ok', text: `Deleted "${config.label}".` });
                    } catch (error) {
                      const message = (error as Error).message;
                      // Already gone is the outcome we wanted anyway.
                      setStatus(
                        /not found/i.test(message)
                          ? { kind: 'info', text: `"${config.label}" was already gone.` }
                          : { kind: 'bad', text: message },
                      );
                    } finally {
                      if (draft.id === config.id) setDraft(EMPTY);
                      await reload();
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
