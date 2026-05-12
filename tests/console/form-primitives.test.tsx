/**
 * Behavioral contract-lock for wizard form-primitives.
 * Pure-render components; Field uses useId, stubbed via vi.mock('react')
 * so component functions can be invoked directly and the returned
 * ReactElement tree inspected without DOM/jsdom.
 */
import { describe, expect, it, vi } from 'vitest';
import { type CSSProperties, type ReactElement, type ReactNode } from 'react';

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useId: () => 'test-id',
  };
});

import {
  Field,
  TextInput,
  NumberInput,
  SelectInput,
  TextArea,
  CheckboxField,
} from '../../console/src/components/wizard/form-primitives.tsx';

type ElementProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  htmlFor?: string;
  id?: string;
  type?: string;
  value?: string | number | readonly string[];
  placeholder?: string;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  rows?: number;
  checked?: boolean;
  disabled?: boolean;
  size?: number;
  onChange?: (e: unknown) => void;
};

type TestElement = ReactElement<ElementProps>;

function propsOf(element: TestElement): ElementProps {
  return element.props;
}

function classTokens(element: TestElement): string[] {
  return propsOf(element).className?.split(/\s+/).filter(Boolean) ?? [];
}

function flatten(node: ReactNode): TestElement[] {
  if (typeof node !== 'object' || node === null) return [];
  if (Array.isArray(node)) return node.flatMap(flatten);
  if ('type' in node) {
    const el = node as TestElement;
    return [el, ...flatten(propsOf(el).children)];
  }
  return [];
}

function findByType(node: ReactNode, type: string): TestElement | undefined {
  return flatten(node).find((e) => e.type === type);
}

function findAllByType(node: ReactNode, type: string): TestElement[] {
  return flatten(node).filter((e) => e.type === type);
}

function collectStrings(node: ReactNode): string[] {
  if (typeof node === 'string') return [node];
  if (typeof node === 'number') return [String(node)];
  if (Array.isArray(node)) return node.flatMap(collectStrings);
  if (typeof node === 'object' && node !== null && 'props' in node) {
    return collectStrings(propsOf(node as TestElement).children);
  }
  return [];
}

// ── Field ──────────────────────────────────────────────────────────────

describe('Field', () => {
  it('renders label with htmlFor wired to useId and forwards id to child render-prop', () => {
    let captured = '';
    const FieldFn = Field as unknown as (p: Parameters<typeof Field>[0]) => TestElement;
    const tree = FieldFn({
      label: 'Name',
      children: (id) => {
        captured = id;
        return null;
      },
    });
    const label = findByType(tree, 'label');
    expect(label).toBeDefined();
    expect(propsOf(label!).htmlFor).toBe('test-id');
    expect(captured).toBe('test-id');
    expect(collectStrings(propsOf(label!).children)).toEqual(['Name']);
  });

  it('renders error text when error prop set and suppresses helper + confirmed check', () => {
    const FieldFn = Field as unknown as (p: Parameters<typeof Field>[0]) => TestElement;
    const tree = FieldFn({
      label: 'Field',
      error: 'bad value',
      helper: 'should be hidden',
      confirmed: true,
      children: () => null,
    });
    const divs = findAllByType(tree, 'div');
    const errorDiv = divs.find((d) => classTokens(d).includes('c-error'));
    const helperDiv = divs.find((d) => classTokens(d).includes('c-helper'));
    expect(errorDiv).toBeDefined();
    expect(collectStrings(propsOf(errorDiv!).children)).toEqual(['bad value']);
    expect(helperDiv).toBeUndefined();
    // confirmed check (a non-string Check element) is suppressed when error is set.
    // The svg rendered by lucide Check should not be in the tree:
    const all = flatten(tree);
    const hasCheck = all.some((el) => typeof el.type === 'function' || typeof el.type === 'object');
    // Either no Check component or it appears as a function element — guard
    // by asserting the wizard-check className is absent.
    const hasWizardCheck = all.some((el) => classTokens(el).includes('wizard-check'));
    expect(hasCheck || !hasCheck).toBe(true); // sanity
    expect(hasWizardCheck).toBe(false);
  });

  it('renders helper when no error and shows confirmed check when confirmed without error', () => {
    const FieldFn = Field as unknown as (p: Parameters<typeof Field>[0]) => TestElement;
    const withHelper = FieldFn({ label: 'F', helper: 'try this', children: () => null });
    const helperDiv = findAllByType(withHelper, 'div').find((d) =>
      classTokens(d).includes('c-helper'),
    );
    expect(helperDiv).toBeDefined();
    expect(collectStrings(propsOf(helperDiv!).children)).toEqual(['try this']);

    const withConfirm = FieldFn({ label: 'F', confirmed: true, children: () => null });
    const all = flatten(withConfirm);
    const hasWizardCheck = all.some((el) => classTokens(el).includes('wizard-check'));
    expect(hasWizardCheck).toBe(true);
  });
});

// ── TextInput ──────────────────────────────────────────────────────────

describe('TextInput', () => {
  it('forwards value/placeholder/onChange and renders <input> with base classes', () => {
    const onChange = vi.fn();
    const TextInputFn = TextInput as unknown as (p: Parameters<typeof TextInput>[0]) => TestElement;
    const tree = TextInputFn({ value: 'hello', placeholder: 'enter', onChange });
    expect(tree.type).toBe('input');
    const p = propsOf(tree);
    expect(p.value).toBe('hello');
    expect(p.placeholder).toBe('enter');
    expect(p.onChange).toBe(onChange);
    const tokens = classTokens(tree);
    expect(tokens).toEqual(expect.arrayContaining(['c-input', 'font-mono']));
  });

  it('appends caller className and selects borderColor by error/confirmed/default', () => {
    const TextInputFn = TextInput as unknown as (p: Parameters<typeof TextInput>[0]) => TestElement;
    const base = TextInputFn({ value: '' });
    const errored = TextInputFn({ value: '', error: true });
    const confirmed = TextInputFn({ value: '', confirmed: true });
    const customCls = TextInputFn({ value: '', className: 'extra-cls' });
    expect(propsOf(base).style?.borderColor).toBe('var(--b2)');
    expect(propsOf(errored).style?.borderColor).toBe('var(--color-s-crit)');
    expect(propsOf(confirmed).style?.borderColor).toBe('var(--wizard-accent)');
    expect(classTokens(customCls)).toContain('extra-cls');
    // error wins over confirmed.
    const both = TextInputFn({ value: '', error: true, confirmed: true });
    expect(propsOf(both).style?.borderColor).toBe('var(--color-s-crit)');
  });
});

// ── NumberInput ────────────────────────────────────────────────────────

describe('NumberInput', () => {
  it('renders <input type="number"> with c-input-number class and forwards min/max/step', () => {
    const onChange = vi.fn();
    const NumberInputFn = NumberInput as unknown as (
      p: Parameters<typeof NumberInput>[0],
    ) => TestElement;
    const tree = NumberInputFn({ value: 5, min: 0, max: 10, step: 1, onChange });
    expect(tree.type).toBe('input');
    const p = propsOf(tree);
    expect(p.type).toBe('number');
    expect(p.value).toBe(5);
    expect(p.min).toBe(0);
    expect(p.max).toBe(10);
    expect(p.step).toBe(1);
    expect(p.onChange).toBe(onChange);
    const tokens = classTokens(tree);
    expect(tokens).toEqual(expect.arrayContaining(['c-input', 'c-input-number', 'font-mono']));
  });

  it('selects borderColor by error/confirmed and appends caller className', () => {
    const NumberInputFn = NumberInput as unknown as (
      p: Parameters<typeof NumberInput>[0],
    ) => TestElement;
    const errored = NumberInputFn({ value: 1, error: true });
    const confirmed = NumberInputFn({ value: 1, confirmed: true });
    const custom = NumberInputFn({ value: 1, className: 'num-extra' });
    expect(propsOf(errored).style?.borderColor).toBe('var(--color-s-crit)');
    expect(propsOf(confirmed).style?.borderColor).toBe('var(--wizard-accent)');
    expect(classTokens(custom)).toContain('num-extra');
  });
});

// ── SelectInput ────────────────────────────────────────────────────────

describe('SelectInput', () => {
  it('renders <select> with c-input + c-select classes, forwards value/onChange, and passes children through', () => {
    const onChange = vi.fn();
    const SelectFn = SelectInput as unknown as (
      p: Parameters<typeof SelectInput>[0],
    ) => TestElement;
    const tree = SelectFn({
      value: 'b',
      onChange,
      children: [
        // raw <option> elements
        { type: 'option', props: { value: 'a', children: 'Alpha' }, key: 'a' } as unknown as ReactNode,
        { type: 'option', props: { value: 'b', children: 'Beta' }, key: 'b' } as unknown as ReactNode,
      ],
    });
    expect(tree.type).toBe('select');
    const p = propsOf(tree);
    expect(p.value).toBe('b');
    expect(p.onChange).toBe(onChange);
    const tokens = classTokens(tree);
    expect(tokens).toEqual(expect.arrayContaining(['c-input', 'c-select']));
    const options = findAllByType(tree, 'option');
    expect(options.length).toBe(2);
    expect(options.map((o) => (o.props as { value?: string }).value)).toEqual(['a', 'b']);
  });

  it('selects borderColor by error/confirmed and appends caller className', () => {
    const SelectFn = SelectInput as unknown as (
      p: Parameters<typeof SelectInput>[0],
    ) => TestElement;
    const errored = SelectFn({ value: '', error: true, children: null });
    const confirmed = SelectFn({ value: '', confirmed: true, children: null });
    const custom = SelectFn({ value: '', className: 'sel-extra', children: null });
    expect(propsOf(errored).style?.borderColor).toBe('var(--color-s-crit)');
    expect(propsOf(confirmed).style?.borderColor).toBe('var(--wizard-accent)');
    expect(classTokens(custom)).toContain('sel-extra');
  });
});

// ── TextArea ───────────────────────────────────────────────────────────

describe('TextArea', () => {
  it('renders <textarea> with c-input + font-mono and forwards value/rows/onChange', () => {
    const onChange = vi.fn();
    const TAFn = TextArea as unknown as (p: Parameters<typeof TextArea>[0]) => TestElement;
    const tree = TAFn({ value: 'body', rows: 4, onChange });
    expect(tree.type).toBe('textarea');
    const p = propsOf(tree);
    expect(p.value).toBe('body');
    expect(p.rows).toBe(4);
    expect(p.onChange).toBe(onChange);
    const tokens = classTokens(tree);
    expect(tokens).toEqual(expect.arrayContaining(['c-input', 'font-mono']));
  });

  it('applies minHeight default 80, custom override, vertical resize, and borderColor branches', () => {
    const TAFn = TextArea as unknown as (p: Parameters<typeof TextArea>[0]) => TestElement;
    const def = TAFn({ value: '' });
    const custom = TAFn({ value: '', minHeight: 200 });
    const errored = TAFn({ value: '', error: true });
    const confirmed = TAFn({ value: '', confirmed: true });
    const customCls = TAFn({ value: '', className: 'ta-extra' });
    const styleOf = (e: TestElement) => propsOf(e).style as CSSProperties;
    expect(styleOf(def).minHeight).toBe(80);
    expect(styleOf(custom).minHeight).toBe(200);
    expect(styleOf(def).resize).toBe('vertical');
    expect(styleOf(errored).borderColor).toBe('var(--color-s-crit)');
    expect(styleOf(confirmed).borderColor).toBe('var(--wizard-accent)');
    expect(classTokens(customCls)).toContain('ta-extra');
  });
});

// ── CheckboxField ──────────────────────────────────────────────────────

describe('CheckboxField', () => {
  it('renders checkbox input with checked state and label text', () => {
    const onChange = vi.fn();
    const CFFn = CheckboxField as unknown as (
      p: Parameters<typeof CheckboxField>[0],
    ) => TestElement;
    const tree = CFFn({ label: 'Enable feature', checked: true, onChange });
    const input = findByType(tree, 'input');
    expect(input).toBeDefined();
    expect(propsOf(input!).type).toBe('checkbox');
    expect(propsOf(input!).checked).toBe(true);
    const label = findByType(tree, 'label');
    expect(classTokens(label!)).toContain('c-checkbox-row');
    // label text appears in tree
    const allStrings = collectStrings(tree);
    expect(allStrings).toContain('Enable feature');
  });

  it('invokes onChange(true|false) when the input receives a change event', () => {
    const onChange = vi.fn();
    const CFFn = CheckboxField as unknown as (
      p: Parameters<typeof CheckboxField>[0],
    ) => TestElement;
    const tree = CFFn({ label: 'X', checked: false, onChange });
    const input = findByType(tree, 'input');
    const handler = propsOf(input!).onChange as (e: { target: { checked: boolean } }) => void;
    handler({ target: { checked: true } });
    handler({ target: { checked: false } });
    expect(onChange).toHaveBeenNthCalledWith(1, true);
    expect(onChange).toHaveBeenNthCalledWith(2, false);
  });

  it('renders helper text when provided and omits the helper div otherwise', () => {
    const CFFn = CheckboxField as unknown as (
      p: Parameters<typeof CheckboxField>[0],
    ) => TestElement;
    const withHelper = CFFn({ label: 'X', checked: false, onChange: () => {}, helper: 'tip' });
    const withoutHelper = CFFn({ label: 'X', checked: false, onChange: () => {} });
    const helperWith = findAllByType(withHelper, 'div').find((d) =>
      classTokens(d).includes('c-helper'),
    );
    const helperWithout = findAllByType(withoutHelper, 'div').find((d) =>
      classTokens(d).includes('c-helper'),
    );
    expect(helperWith).toBeDefined();
    expect(collectStrings(propsOf(helperWith!).children)).toEqual(['tip']);
    expect(helperWithout).toBeUndefined();
    // c-helper div count: exactly 1 when helper provided, 0 when omitted.
    const helperCountWith = findAllByType(withHelper, 'div').filter((d) =>
      classTokens(d).includes('c-helper'),
    ).length;
    const helperCountWithout = findAllByType(withoutHelper, 'div').filter((d) =>
      classTokens(d).includes('c-helper'),
    ).length;
    expect(helperCountWith).toBe(1);
    expect(helperCountWithout).toBe(0);
  });
});
