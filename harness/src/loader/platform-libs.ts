/**
 * Sets up versioned global aliases for platform libraries.
 *
 * React UMD scripts are injected into HTML by the Vite plugin (transformIndexHtml)
 * so window.React and window.ReactDOM are already available.
 * This module aliases them to the versioned names the PCF bundle expects:
 *   React 16  → window.Reactv16 / window.ReactDOMv16
 *   React 18  → window.Reactv18 / window.ReactDOMv18
 *
 * For Fluent UI, a Proxy stub is provided since the UMD bundle is too large (~4MB).
 */

import type { ManifestResources } from '../types/manifest';

/**
 * Set up versioned global aliases and Fluent UI stubs.
 * Must be called BEFORE the PCF bundle script is loaded.
 */
export async function loadPlatformLibraries(resources: ManifestResources): Promise<void> {
  const libs = resources.platformLibraries;
  if (!libs || libs.length === 0) return;

  const w = window as any;

  // Alias React/ReactDOM globals to versioned names
  const reactLib = libs.find(l => l.name === 'React');
  if (reactLib && w.React) {
    const major = reactLib.version.split('.')[0];
    const reactGlobal = `Reactv${major}`;
    const reactDomGlobal = `ReactDOMv${major}`;

    w[reactGlobal] = w.React;
    w[reactDomGlobal] = w.ReactDOM;
    console.log(`[pcf-workbench] React ${major} aliased: window.${reactGlobal}, window.${reactDomGlobal}`);
  }

  // Set up Fluent UI stub
  const fluentLib = libs.find(l => l.name === 'Fluent');
  if (fluentLib) {
    const [major, minor, patch] = fluentLib.version.split('.').map(Number);
    const globalName = major >= 9
      ? 'FluentUIReactv940'
      : (minor <= 29 && patch <= 0) ? 'FluentUIReactv8290' : 'FluentUIReactv81211';

    if (!w[globalName]) {
      console.log(`[pcf-workbench] Fluent UI v${fluentLib.version} — stub as window.${globalName}`);
      w[globalName] = createFluentStub(w);
    }
  }
}

function createFluentStub(w: any) {
  const getReact = () => w.Reactv16 ?? w.Reactv18 ?? w.React;

  // Helper to create a stub component that renders as an HTML element
  const comp = (tag: string, displayName: string) => {
    const c = (props: any) => {
      const R = getReact();
      if (!R) return null;
      const { children, text, label, placeholder, style, className, onClick, onChange, onBlur, checked, value, disabled, ...rest } = props;
      const htmlProps: any = { 'data-fluent': displayName, style, className, onClick };
      if (disabled) htmlProps['data-disabled'] = 'true';
      const content = children ?? text ?? label ?? null;
      return R.createElement(tag, htmlProps, content);
    };
    c.displayName = `FluentStub(${displayName})`;
    return c;
  };

  // Enum/constant stubs
  const enums: Record<string, any> = {
    MessageBarType: { info: 0, error: 1, blocked: 2, severeWarning: 3, success: 4, warning: 5 },
    SpinnerSize: { xSmall: 0, small: 1, medium: 2, large: 3 },
    DropdownMenuItemType: { normal: 0, divider: 1, header: 2 },
    SelectableOptionMenuItemType: { normal: 0, divider: 1, header: 2 },
    DatePickerDayOfWeek: { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 },
    IconType: { default: 0, image: 1 },
    ResponsiveMode: { small: 0, medium: 1, large: 2, xLarge: 3, xxLarge: 4, xxxLarge: 5 },
  };

  // Explicit component stubs with appropriate HTML tags
  const components: Record<string, any> = {
    Stack: Object.assign(comp('div', 'Stack'), {
      Item: comp('div', 'Stack.Item'),
    }),
    StackItem: comp('div', 'StackItem'),
    Text: comp('span', 'Text'),
    Label: comp('label', 'Label'),
    TextField: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'TextField', style: props.style },
        props.label && R.createElement('label', null, props.label),
        R.createElement('input', {
          type: props.type ?? 'text', value: props.value ?? '', placeholder: props.placeholder,
          disabled: props.disabled, onChange: (e: any) => props.onChange?.(e, e.target.value),
          onBlur: props.onBlur, style: { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 2 },
        }),
      );
    },
    Dropdown: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'Dropdown', style: props.style },
        props.label && R.createElement('label', null, props.label),
        R.createElement('select', {
          value: props.selectedKey ?? '', disabled: props.disabled,
          onChange: (e: any) => props.onChange?.(e, { key: e.target.value, text: e.target.options[e.target.selectedIndex]?.text }),
          style: { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 2 },
        }, (props.options ?? []).map((o: any) => R.createElement('option', { key: o.key, value: o.key }, o.text))),
      );
    },
    ComboBox: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'ComboBox' },
        props.label && R.createElement('label', null, props.label),
        R.createElement('input', {
          value: props.text ?? '', placeholder: props.placeholder, disabled: props.disabled,
          style: { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 2 },
        }),
      );
    },
    Checkbox: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('label', { 'data-fluent': 'Checkbox', style: { display: 'flex', alignItems: 'center', gap: 6, ...props.style } },
        R.createElement('input', {
          type: 'checkbox', checked: props.checked ?? false, disabled: props.disabled,
          onChange: (e: any) => props.onChange?.(e, e.target.checked),
        }),
        R.createElement('span', null, props.label),
      );
    },
    ChoiceGroup: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'ChoiceGroup', style: props.style },
        props.label && R.createElement('label', { style: { fontWeight: 600 } }, props.label),
        ...(props.options ?? []).map((o: any) =>
          R.createElement('label', { key: o.key, style: { display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' } },
            R.createElement('input', {
              type: 'radio', name: props.name ?? 'choice', value: o.key,
              checked: props.selectedKey === o.key, disabled: props.disabled || o.disabled,
              onChange: () => props.onChange?.(null, o),
            }),
            R.createElement('span', null, o.text),
          ),
        ),
      );
    },
    Toggle: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('label', { 'data-fluent': 'Toggle', style: { display: 'flex', alignItems: 'center', gap: 6, ...props.style } },
        R.createElement('input', {
          type: 'checkbox', checked: props.checked ?? false, disabled: props.disabled,
          onChange: (e: any) => props.onChange?.(e, e.target.checked),
        }),
        R.createElement('span', null, props.label ?? props.onText ?? ''),
      );
    },
    SpinButton: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'SpinButton', style: props.style },
        props.label && R.createElement('label', null, props.label),
        R.createElement('input', {
          type: 'number', defaultValue: props.value ?? '', disabled: props.disabled, min: props.min, max: props.max,
          onChange: (e: any) => props.onChange?.(e, e.target.value),
          onBlur: props.onBlur,
          style: { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 2 },
        }),
      );
    },
    DatePicker: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', { 'data-fluent': 'DatePicker', style: props.style },
        props.label && R.createElement('label', null, props.label),
        R.createElement('input', {
          type: 'date', disabled: props.disabled, placeholder: props.placeholder,
          style: { width: '100%', padding: '6px 8px', border: '1px solid #ccc', borderRadius: 2 },
        }),
      );
    },
    DefaultButton: (props: any) => {
      const R = getReact();
      if (!R) return null;
      const isPrimary = props.primary === true;
      return R.createElement('button', {
        'data-fluent': 'DefaultButton', onClick: props.onClick, disabled: props.disabled,
        className: props.className || '',
        style: {
          padding: '6px 16px',
          backgroundColor: isPrimary ? '#0078d4' : '#fff',
          color: isPrimary ? '#fff' : '#323130',
          border: isPrimary ? 'none' : '1px solid #8a8886',
          borderRadius: 2, cursor: 'pointer', fontSize: '14px', fontWeight: 600, lineHeight: '20px',
          minWidth: '80px', textAlign: 'center' as const, ...props.style,
        },
      }, props.text, props.children);
    },
    PrimaryButton: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('button', {
        'data-fluent': 'PrimaryButton', onClick: props.onClick, disabled: props.disabled,
        className: props.className || '',
        style: {
          padding: '6px 20px', backgroundColor: '#0078d4', color: 'white', border: 'none',
          borderRadius: 2, cursor: 'pointer', fontSize: '14px', fontWeight: 600, lineHeight: '20px',
          minWidth: '80px', textAlign: 'center', ...props.style,
        },
      }, props.text, props.children);
    },
    IconButton: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('button', {
        'data-fluent': 'IconButton', onClick: props.onClick, disabled: props.disabled,
        className: props.className || '',
        title: props.title,
        style: {
          padding: '4px 8px', backgroundColor: 'transparent', border: '1px solid #8a8886',
          borderRadius: 2, cursor: 'pointer', display: 'inline-flex', alignItems: 'center',
          justifyContent: 'center', minWidth: '32px', minHeight: '32px', ...props.style,
        },
      }, props.children);
    },
    MessageBar: (props: any) => {
      const R = getReact();
      if (!R) return null;
      const bgColors: Record<number, string> = { 0: '#f3f2f1', 1: '#fde7e9', 4: '#dff6dd', 5: '#fff4ce' };
      return R.createElement('div', {
        'data-fluent': 'MessageBar',
        style: { padding: '8px 12px', backgroundColor: bgColors[props.messageBarType ?? 0] ?? '#f3f2f1', borderRadius: 2, ...props.style },
      }, props.children);
    },
    Spinner: (props: any) => {
      const R = getReact();
      if (!R || props.hidden) return null;
      return R.createElement('div', {
        'data-fluent': 'Spinner', style: { textAlign: 'center', padding: 16, ...props.style },
      }, props.label ?? 'Loading...');
    },
    Icon: (props: any) => {
      const R = getReact();
      if (!R) return null;
      const iconName = props.iconName ?? '';

      // Check icon registry first (for icons registered via registerIcons)
      const registered = iconRegistry[iconName.toLowerCase()];
      if (registered) {
        // Registered icons are typically React elements (JSX/SVG)
        if (typeof registered === 'object' && registered !== null) {
          return R.createElement('span', {
            'data-fluent': 'Icon', 'data-icon': iconName,
            style: { display: 'inline-flex', ...props.style },
            dangerouslySetInnerHTML: typeof registered === 'string' ? { __html: registered } : undefined,
          }, typeof registered !== 'string' ? registered : undefined);
        }
      }

      // Fallback: common Fluent icon names → Unicode symbols
      const iconMap: Record<string, string> = {
        FavoriteStar: '\u2605', FavoriteStarFill: '\u2605', FavoriteStarEmpty: '\u2606',
        Cancel: '\u2715', CheckMark: '\u2713', Add: '\u002B', Delete: '\u2716',
        Edit: '\u270E', Search: '\u2315', ChevronRight: '\u203A', ChevronLeft: '\u2039',
        ChevronDown: '\u2304', ChevronUp: '\u2303', Info: '\u2139', Warning: '\u26A0',
        Error: '\u2716', Camera: '\u{1F4F7}', Attach: '\u{1F4CE}', Save: '\u{1F4BE}', PDF: '\u{1F4C4}',
      };
      const symbol = iconMap[iconName] ?? iconName ?? '';
      return R.createElement('span', {
        'data-fluent': 'Icon', 'data-icon': iconName,
        style: { ...props.style, fontStyle: 'normal' },
      }, symbol);
    },
    ProgressIndicator: (props: any) => {
      const R = getReact();
      if (!R || props.hidden) return null;
      return R.createElement('div', {
        'data-fluent': 'ProgressIndicator',
        style: { padding: '8px 0', ...props.style },
      },
        props.label && R.createElement('div', { style: { fontSize: 12, marginBottom: 4 } }, props.label),
        R.createElement('div', {
          style: { height: 4, backgroundColor: '#edebe9', borderRadius: 2, overflow: 'hidden' },
        }, R.createElement('div', {
          style: {
            height: '100%', width: props.percentComplete != null ? `${props.percentComplete * 100}%` : '40%',
            backgroundColor: '#0078d4', borderRadius: 2,
            animation: props.percentComplete == null ? 'none' : undefined,
          },
        })),
        props.description && R.createElement('div', { style: { fontSize: 11, color: '#605e5c', marginTop: 4 } }, props.description),
      );
    },
    Modal: (props: any) => {
      const R = getReact();
      if (!R || !props.isOpen) return null;
      return R.createElement('div', {
        'data-fluent': 'Modal',
        className: props.containerClassName || '',
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.4)',
        },
      }, R.createElement('div', {
        style: { backgroundColor: '#fff', borderRadius: 4, padding: '24px', minWidth: 340, maxWidth: 600, maxHeight: '80vh', overflow: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.2)' },
      }, props.children));
    },
    Dialog: (props: any) => {
      const R = getReact();
      if (!R || props.hidden) return null;
      return R.createElement('div', {
        'data-fluent': 'Dialog',
        style: {
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 10000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.4)',
        },
      }, R.createElement('div', {
        style: {
          backgroundColor: '#fff', borderRadius: 4, padding: '24px', minWidth: 340, maxWidth: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
        },
      },
        props.dialogContentProps?.title && R.createElement('div', { style: { fontSize: 20, fontWeight: 600, marginBottom: 12 } }, props.dialogContentProps.title),
        props.dialogContentProps?.subText && R.createElement('div', { style: { fontSize: 14, color: '#605e5c', marginBottom: 16 } }, props.dialogContentProps.subText),
        props.children,
      ));
    },
    DialogFooter: (props: any) => {
      const R = getReact();
      if (!R) return null;
      return R.createElement('div', {
        'data-fluent': 'DialogFooter',
        style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 },
      }, props.children);
    },
    ThemeProvider: (props: any) => {
      const R = getReact();
      return R ? R.createElement(R.Fragment, null, props.children) : null;
    },
  };

  // Icon registry — stores icons registered via registerIcons()
  const iconRegistry: Record<string, any> = {};

  // Utility function stubs
  const utilities: Record<string, any> = {
    mergeStyles: (..._args: any[]) => '',
    mergeStyleSets: (...args: any[]) => args.reduce((a: any, b: any) => ({ ...a, ...b }), {}),
    concatStyleSets: (...args: any[]) => args.reduce((a: any, b: any) => ({ ...a, ...b }), {}),
    concatStyleSetsWithProps: (...args: any[]) => args.reduce((a: any, b: any) => ({ ...a, ...b }), {}),
    createTheme: (t: any) => t ?? {},
    loadTheme: () => {},
    getTheme: () => ({ palette: {}, fonts: {}, semanticColors: {} }),
    useTheme: () => ({ palette: {}, fonts: {}, semanticColors: {} }),
    styled: (component: any) => component,
    classNamesFunction: () => () => ({}),
    getNativeProps: (props: any) => props ?? {},
    getId: (prefix?: string) => `${prefix ?? 'id'}-${Math.random().toString(36).slice(2, 8)}`,
    css: (...args: any[]) => args.filter(Boolean).join(' '),
    initializeIcons: () => {},
    registerIcons: (iconSet: any) => {
      // Store registered icons so Icon component can render them
      if (iconSet?.icons) {
        for (const [name, value] of Object.entries(iconSet.icons)) {
          iconRegistry[name.toLowerCase()] = value;
        }
      }
    },
    FontWeights: { regular: 400, semibold: 600, bold: 700 },
    FontSizes: { mini: '10px', xSmall: '10px', small: '12px', smallPlus: '13px', medium: '14px', mediumPlus: '15px', large: '16px', xLarge: '20px', xxLarge: '28px' },
    AnimationStyles: {},
    DefaultPalette: {},
  };

  // Build the combined lookup
  const allExports: Record<string, any> = { ...enums, ...components, ...utilities };

  return new Proxy(allExports, {
    get(target, prop) {
      if (typeof prop === 'symbol') return undefined;
      const key = prop as string;

      // Known export
      if (key in target) return target[key];

      // Unknown uppercase — return a generic component stub
      if (key[0] >= 'A' && key[0] <= 'Z') {
        const c = comp('div', key);
        target[key] = c; // Cache it
        return c;
      }

      return undefined;
    },
  });
}

/**
 * Get the versioned ReactDOM global for rendering virtual control output.
 */
export function getReactDOMGlobal(resources: ManifestResources): any | null {
  const reactLib = resources.platformLibraries.find(l => l.name === 'React');
  if (!reactLib) return null;
  const major = reactLib.version.split('.')[0];
  const globalName = `ReactDOMv${major}`;
  return (window as any)[globalName] ?? (window as any).ReactDOM ?? null;
}
