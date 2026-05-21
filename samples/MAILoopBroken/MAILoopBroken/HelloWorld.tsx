import * as React from 'react';
import { Label } from '@fluentui/react-components';

export interface IHelloWorldProps {
  name?: string;
  // BUG #2 lever: an optional object whose `.value` is accessed during
  // render. The control supplies `undefined` for this prop on purpose so
  // the deref below throws inside React.
  crashMe?: { value: string };
}

export class HelloWorld extends React.Component<IHelloWorldProps> {
  public render(): React.ReactNode {
    // BUG #2: undefined deref. Throws inside the render phase.
    const crash = this.props.crashMe!.value;
    return (
      <Label>
        Hello {this.props.name}! {crash}
      </Label>
    )
  }
}

