'use client';

import {
  AVATAR_SHAPES,
  type BotCreateRequest,
  type BotView,
  ENGINE_LABELS,
  MODEL_SUGGESTIONS,
  NOTIFICATION_LEVELS,
  USER_ENGINES,
} from '@agenta/shared';
import { type FormEvent, type ReactNode, useState } from 'react';
import { BotAvatar } from '@/components/bot-avatar';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, invalidProps } from '@/components/ui/form';
import { ApiClientError } from '@/lib/api';
import {
  AVATAR_COLORS,
  type BotFormErrors,
  type BotFormValues,
  formToRequest,
  slugPreview,
} from '@/lib/bots';
import { cn } from '@/lib/utils';
import { MarkdownEditor } from './markdown-editor';

const NOTIFICATION_LABELS = {
  all: 'All messages',
  mentions: 'Only @mentions',
  none: 'None',
} as const;

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-4 border-b pb-6 last:border-b-0 md:grid-cols-[200px_1fr]">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/**
 * Create / edit form for a bot. Validation uses the runner's own zod schema (lib/bots.ts); a server-side
 * `slug_taken` is shown on the handle field. `onSubmit` throws ApiClientError on failure.
 */
export function BotForm({
  initial,
  base,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial: BotFormValues;
  /** The saved bot when editing (keeps advanced settings like flags). */
  base?: BotView;
  submitLabel: string;
  onSubmit: (body: BotCreateRequest) => Promise<void>;
  onCancel?: () => void;
}) {
  const [values, setValues] = useState<BotFormValues>(initial);
  const [errors, setErrors] = useState<BotFormErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function set<K extends keyof BotFormValues>(key: K, value: BotFormValues[K]) {
    setValues((v) => ({ ...v, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    setFormError(null);
    const res = formToRequest(values, base);
    if (!res.ok) {
      setErrors(res.errors);
      const first = Object.keys(res.errors)[0];
      if (first) document.getElementById(`bot-${first}`)?.focus();
      return;
    }
    setPending(true);
    try {
      await onSubmit(res.body);
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'slug_taken') setErrors({ slug: err.message });
      else setFormError(err instanceof Error ? err.message : 'Could not save the bot');
    } finally {
      setPending(false);
    }
  }

  const text = (key: keyof BotFormValues) => ({
    id: `bot-${key}`,
    value: values[key] as string,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
    ...invalidProps(`bot-${key}`, errors[key]),
  });
  const suggestions = MODEL_SUGGESTIONS[values.engine];

  return (
    <form onSubmit={submit} noValidate className="space-y-6" aria-label="Bot settings">
      <Section title="Profile" description="How the bot appears in the sidebar, chats and @mentions.">
        <div className="flex items-center gap-4">
          <BotAvatar
            name={values.name || '?'}
            color={values.avatarColor}
            shape={values.avatarShape}
            size="lg"
          />
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="bot-name" error={errors.name}>
              <Input {...text('name')} maxLength={64} placeholder="Code Reviewer" autoComplete="off" />
            </Field>
            <Field
              label="Handle"
              htmlFor="bot-slug"
              error={errors.slug}
              hint={`Used for @mentions. ${values.slug ? '' : `Default: @${slugPreview(values.name)}`}`}
            >
              <Input
                {...text('slug')}
                maxLength={48}
                placeholder={slugPreview(values.name)}
                autoComplete="off"
              />
            </Field>
          </div>
        </div>
        <Field label="Role" htmlFor="bot-role" error={errors.role} hint="One line, shown under the name.">
          <Input {...text('role')} maxLength={200} placeholder="Reviews pull requests for bugs and style" />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Avatar colour</legend>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`Colour ${c}`}
                aria-pressed={values.avatarColor === c}
                onClick={() => set('avatarColor', c)}
                className={cn(
                  'size-7 rounded-full ring-offset-2 ring-offset-background transition-shadow',
                  values.avatarColor === c && 'ring-2 ring-ring',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="color"
                aria-label="Custom colour"
                value={values.avatarColor}
                onChange={(e) => set('avatarColor', e.target.value)}
                className="size-7 cursor-pointer rounded border bg-transparent"
              />
              Custom
            </label>
          </div>
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Avatar shape</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="Avatar shape">
            {AVATAR_SHAPES.map((shape) => (
              <button
                key={shape}
                type="button"
                role="radio"
                aria-checked={values.avatarShape === shape}
                onClick={() => set('avatarShape', shape)}
                className={cn(
                  'flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm capitalize',
                  values.avatarShape === shape && 'border-ring bg-accent',
                )}
              >
                <BotAvatar name={values.name || '?'} color={values.avatarColor} shape={shape} size="sm" />
                {shape}
              </button>
            ))}
          </div>
        </fieldset>
      </Section>

      <Section title="Engine" description="The coding agent that runs inside the bot's computer.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Engine" htmlFor="bot-engine">
            <Select
              id="bot-engine"
              value={values.engine}
              onChange={(e) => set('engine', e.target.value as BotFormValues['engine'])}
            >
              {/* `mock` is API-only, but a mock bot must still show its engine. */}
              {[...USER_ENGINES, ...(values.engine === 'mock' ? (['mock'] as const) : [])].map((e) => (
                <option key={e} value={e}>
                  {ENGINE_LABELS[e]}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Model"
            htmlFor="bot-model"
            error={errors.model}
            hint="Leave empty to use the engine's default."
          >
            <Input {...text('model')} list="bot-model-suggestions" maxLength={100} placeholder="default" />
            <datalist id="bot-model-suggestions">
              {suggestions.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </Field>
        </div>
      </Section>

      <Section
        title="Instructions"
        description="Markdown. Rendered into the bot's CLAUDE.md / AGENTS.md before every run."
      >
        <MarkdownEditor
          id="bot-instructions"
          label="Instructions"
          value={values.instructions}
          onChange={(v) => set('instructions', v)}
          error={errors.instructions}
          placeholder={'# Role\nYou review pull requests…\n\n## Rules\n- Be specific'}
        />
      </Section>

      <Section
        title="Notifications"
        description="What reaches your inbox and how the bot shows in the sidebar."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Notify me about" htmlFor="bot-notifications">
            <Select
              id="bot-notifications"
              value={values.notifications}
              onChange={(e) => set('notifications', e.target.value as BotFormValues['notifications'])}
            >
              {NOTIFICATION_LEVELS.map((n) => (
                <option key={n} value={n}>
                  {NOTIFICATION_LABELS[n]}
                </option>
              ))}
            </Select>
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input
              id="bot-sidebarVisible"
              type="checkbox"
              checked={values.sidebarVisible}
              onChange={(e) => set('sidebarVisible', e.target.checked)}
              className="size-4 accent-primary"
            />
            Show in sidebar
          </label>
        </div>
      </Section>

      <Section
        title="Computer"
        description="Limits for the bot's container. RAM and CPU changes apply when the computer next starts."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="RAM (MB)" htmlFor="bot-memoryMb" error={errors.memoryMb}>
            <Input {...text('memoryMb')} type="number" inputMode="numeric" min={256} max={65536} step={256} />
          </Field>
          <Field label="CPUs" htmlFor="bot-cpus" error={errors.cpus}>
            <Input {...text('cpus')} type="number" inputMode="decimal" min={0.5} max={16} step={0.5} />
          </Field>
          <Field
            label="Idle timeout (min)"
            htmlFor="bot-idleTimeoutMin"
            error={errors.idleTimeoutMin}
            hint="Stop the computer after this long without activity. 0 = never."
          >
            <Input {...text('idleTimeoutMin')} type="number" inputMode="numeric" min={0} max={1440} />
          </Field>
          <Field
            label="Run timeout (min)"
            htmlFor="bot-runTimeoutMin"
            error={errors.runTimeoutMin}
            hint="Cancel a single run after this long. Empty = default (30)."
          >
            <Input
              {...text('runTimeoutMin')}
              type="number"
              inputMode="numeric"
              min={1}
              max={1440}
              placeholder="30"
            />
          </Field>
        </div>
      </Section>

      {formError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}
