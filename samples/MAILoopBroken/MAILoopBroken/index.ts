import { IInputs, IOutputs } from "./generated/ManifestTypes";
import { HelloWorld, IHelloWorldProps } from "./HelloWorld";
import * as React from "react";

/**
 * MAILoopBroken — a deliberately broken PCF control used as the
 * negative-path fixture for the AI Build Loop (see
 * `samples/MAILoopDemo/README.md`). Two intentional bugs:
 *
 *   1. A `setInterval` and a `window` listener are registered in
 *      `init()` and never cleaned up in `destroy()`. The harness's
 *      resource-tracker will report both as leaks.
 *
 *   2. `HelloWorld` dereferences an undefined prop, which throws inside
 *      React's render phase and emits a console error. The harness
 *      classifies this as a render failure.
 *
 * Do NOT fix these bugs — they exist for documentation and CI
 * coverage. The fixed equivalent of this control is the in-tree
 * `samples/ConformanceTester` sample.
 */
export class MAILoopBroken implements ComponentFramework.ReactControl<IInputs, IOutputs> {
    private notifyOutputChanged: () => void;

    constructor() {
        // Empty
    }

    public init(
        context: ComponentFramework.Context<IInputs>,
        notifyOutputChanged: () => void,
        _state: ComponentFramework.Dictionary
    ): void {
        this.notifyOutputChanged = notifyOutputChanged;

        // BUG #1a: setInterval that destroy() never clears.
        setInterval(() => {
            // No-op poll — exists only to demonstrate the leak.
        }, 1000);

        // BUG #1b: window listener that destroy() never removes.
        window.addEventListener("resize", () => {
            this.notifyOutputChanged();
        });
    }

    public updateView(_context: ComponentFramework.Context<IInputs>): React.ReactElement {
        // BUG #2: `crashMe` is not provided; the render below dereferences
        // `props.crashMe.value`, which throws.
        const props = { name: "Power Apps" } as unknown as IHelloWorldProps;
        return React.createElement(HelloWorld, props);
    }

    public getOutputs(): IOutputs {
        return {};
    }

    public destroy(): void {
        // INTENTIONAL: no cleanup. See class JSDoc.
    }
}

