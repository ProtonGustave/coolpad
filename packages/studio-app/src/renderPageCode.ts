import { PropValueTypes } from '@mui/studio-core';
import * as prettier from 'prettier';
import parserBabel from 'prettier/parser-babel';
import Imports from './codeGen/Imports';
import Scope from './codeGen/Scope';
import { getStudioComponent } from './studioComponents';
import * as studioDom from './studioDom';
import {
  NodeId,
  PropExpression,
  RenderContext,
  ResolvedProps,
  StudioComponentDefinition,
  StudioNodeProp,
  StudioNodeProps,
} from './types';
import { camelCase } from './utils/strings';
import { ExactEntriesOf } from './utils/types';
import * as bindings from './utils/bindings';

export interface RenderPageConfig {
  // whether we're in the context of an editor
  editor: boolean;
  // prettify output
  pretty: boolean;
}

class Context implements RenderContext {
  private dom: studioDom.StudioDom;

  private page: studioDom.StudioPageNode;

  private editor: boolean;

  private imports: Imports;

  private dataLoaders: { queryId: string; variable: string }[] = [];

  private moduleScope: Scope;

  private reactAlias: string = 'undefined';

  private runtimeAlias: string = 'undefined';

  private useStateHooks: {
    [id in string]?: { state: string; setState: string; defaultValue?: unknown };
  } = {};

  private useMemoHooks: {
    [id in string]?: string;
  } = {};

  private state: { [id: string]: string } = {};

  constructor(
    dom: studioDom.StudioDom,
    page: studioDom.StudioPageNode,
    { editor }: RenderPageConfig,
  ) {
    this.dom = dom;
    this.page = page;
    this.editor = editor;

    this.moduleScope = new Scope(null);

    this.imports = new Imports(this.moduleScope);

    this.reactAlias = this.addImport('react', 'default', 'React');

    if (this.editor) {
      this.runtimeAlias = this.addImport('@mui/studio-core/runtime', '*', '__studioRuntime');
    }
  }

  useDataLoader(queryId: string): string {
    const variable = this.moduleScope.createUniqueBinding(queryId);
    this.dataLoaders.push({ queryId, variable });
    return variable;
  }

  getComponentDefinition(node: studioDom.StudioNode): StudioComponentDefinition | null {
    if (studioDom.isPage(node)) {
      return getStudioComponent(this.dom, 'Page');
    }
    if (studioDom.isElement(node)) {
      return getStudioComponent(this.dom, node.component);
    }
    return null;
  }

  collectAllState() {
    const nodes = studioDom.getDescendants(this.dom, this.page);
    nodes.forEach((node) => {
      (Object.values(node.props) as StudioNodeProp<unknown>[]).forEach((prop) => {
        if (prop?.type === 'boundExpression') {
          const parsedExpr = bindings.parse(prop.value);
          bindings
            .getInterpolations(parsedExpr)
            .forEach((interpolation) => this.collectInterpolation(interpolation));
        } else if (prop?.type === 'binding') {
          this.collectInterpolation(prop.value);
        }
      });
    });
  }

  collectInterpolation(interpolation: string) {
    const [nodeName, ...path] = interpolation.split('.');
    const nodeId = studioDom.getNodeIdByName(this.dom, nodeName);

    if (!nodeId) {
      console.warn(`Can't find node with name "${nodeName}"`);
      return;
    }

    const node = studioDom.getNode(this.dom, nodeId);

    if (studioDom.isElement(node)) {
      const [prop, ...subPath] = path;

      const stateId = `${nodeId}.${prop}`;

      let stateHook = this.useStateHooks[stateId];
      if (!stateHook) {
        const component = this.getComponentDefinition(node);

        if (!component) {
          throw new Error(`Can't find component for node "${node.id}"`);
        }

        const argType = component.argTypes[prop];

        if (!argType) {
          throw new Error(`Can't find argType for "${node.name}.${prop}"`);
        }

        if (!argType.onChangeHandler) {
          throw new Error(`"${node.name}.${prop}" is not a controlled property`);
        }

        const stateVarSuggestion = camelCase(nodeName, prop);
        const state = this.moduleScope.createUniqueBinding(stateVarSuggestion);

        const setStateVarSuggestion = camelCase('set', nodeName, prop);
        const setState = this.moduleScope.createUniqueBinding(setStateVarSuggestion);

        stateHook = {
          state,
          setState,
          defaultValue: argType.defaultValue,
        };
        this.useStateHooks[stateId] = stateHook;
      }

      this.state[interpolation] = [stateHook.state, ...subPath].join('.');
    } else if (studioDom.isDerivedState(node)) {
      let state = this.useMemoHooks[node.id];
      if (!state) {
        state = this.moduleScope.createUniqueBinding(node.name);
        this.useMemoHooks[node.id] = state;
      }
      this.state[interpolation] = state;
    }
  }

  getPropTypes(node: studioDom.StudioNode): PropValueTypes {
    if (studioDom.isElement(node)) {
      const component = this.getComponentDefinition(node);
      if (!component) {
        return {};
      }
      return Object.fromEntries(
        Object.entries(component.argTypes).flatMap(([propName, argType]) =>
          argType ? [[propName, argType.typeDef]] : [],
        ),
      );
    }
    if (studioDom.isDerivedState(node)) {
      return node.argTypes;
    }
    return {};
  }

  /**
   * Resolves StudioNode properties to expressions we can render in the code.
   * This will set up databinding if necessary
   */
  resolveProps<P>(node: studioDom.StudioNode, resolvedChildren: ResolvedProps): ResolvedProps {
    const result: ResolvedProps = resolvedChildren;
    const propTypes = this.getPropTypes(node);

    // User props
    (Object.entries(node.props) as ExactEntriesOf<StudioNodeProps<P>>).forEach(
      ([propName, propValue]) => {
        const propType = propTypes[propName as string];
        if (!propType || !propValue || typeof propName !== 'string' || result[propName]) {
          return;
        }

        if (propType.type === 'dataQuery') {
          if (propValue.type !== 'const') {
            throw new Error(`TODO: make this work for bindings`);
          }
          if (propValue.value && typeof propValue.value === 'string') {
            const spreadedValue = this.useDataLoader(propValue.value);
            result.$spread = `${result.$spread ? `${result.$spread} ` : ''}{...${spreadedValue}}`;
          }
        } else if (propValue.type === 'const') {
          result[propName] = {
            type: 'expression',
            value: JSON.stringify(propValue.value),
          };
        } else if (propValue.type === 'boundExpression') {
          const parsedExpr = bindings.parse(propValue.value);

          // Resolve each named variable to its resolved variable in code
          const resolvedExpr = bindings.resolve(parsedExpr, (part) => this.state[part]);

          const value = bindings.format(resolvedExpr, propValue.format);

          result[propName] = {
            type: 'expression',
            value,
          };
        } else if (propValue.type === 'binding') {
          result[propName] = {
            type: 'expression',
            value: this.state[propValue.value],
          };
        } else {
          console.warn(`Invariant: Unkown prop type "${(propValue as any).type}"`);
        }
      },
    );

    // Hooks
    const component = this.getComponentDefinition(node);
    if (component) {
      Object.entries(component.argTypes).forEach(([propName, argType]) => {
        if (!argType) {
          return;
        }

        const stateId = `${node.id}.${propName}`;
        const hook = this.useStateHooks[stateId];

        if (!hook) {
          return;
        }

        result[propName] = {
          type: 'expression',
          value: hook.state,
        };

        if (argType.onChangeProp) {
          if (argType.onChangeHandler) {
            // TODO: React.useCallback for this?
            const { params, valueGetter } = argType.onChangeHandler;
            result[argType.onChangeProp] = {
              type: 'expression',
              value: `(${params.join(', ')}) => ${hook.setState}(${valueGetter})`,
            };
          } else {
            result[argType.onChangeProp] = {
              type: 'expression',
              value: hook.setState,
            };
          }
        }
      });
    }

    // Default values
    if (component) {
      Object.entries(component.argTypes).forEach(([propName, argType]) => {
        if (argType && argType.defaultValue !== undefined && !result[propName]) {
          const defaultPropName = argType.defaultValueProp ?? propName;
          result[defaultPropName] = {
            type: 'expression',
            value: JSON.stringify(argType.defaultValue),
          };
        }
      });
    }

    return result;
  }

  renderComponent(name: string, resolvedProps: ResolvedProps): string {
    const { children, ...props } = resolvedProps;
    return children
      ? `<${name} ${this.renderProps(props)}>${this.renderJsxContent(children)}</${name}>`
      : `<${name} ${this.renderProps(props)}/>`;
  }

  renderNodeChildren(node: studioDom.StudioElementNode | studioDom.StudioPageNode): ResolvedProps {
    const result: ResolvedProps = {};
    const nodeChildren = studioDom.getChildNodes(this.dom, node);

    const renderableNodeChildren = studioDom.isPage(node)
      ? { children: nodeChildren.children }
      : nodeChildren;

    // eslint-disable-next-line no-restricted-syntax
    for (const [prop, children] of Object.entries(renderableNodeChildren)) {
      if (children) {
        if (children.length === 1) {
          result[prop] = this.renderNode(children[0]);
        } else if (children.length > 1) {
          result[prop] = {
            type: 'jsxFragment',
            value: children
              .map((child): string => this.renderJsxContent(this.renderNode(child)))
              .join('\n'),
          };
        }
      }
    }

    const component = this.getComponentDefinition(node);

    if (this.editor && component) {
      // eslint-disable-next-line no-restricted-syntax
      for (const [prop, argType] of Object.entries(component.argTypes)) {
        if (argType?.typeDef.type === 'element') {
          if (argType.control?.type === 'slots') {
            const existingProp = result[prop];

            result[prop] = {
              type: 'jsxElement',
              value: `
                <${this.runtimeAlias}.Slots prop=${JSON.stringify(prop)}>
                  ${existingProp ? this.renderJsxContent(existingProp) : ''}
                </${this.runtimeAlias}.Slots>
              `,
            };
          } else if (argType.control?.type === 'slot') {
            const existingProp = result[prop];

            result[prop] = {
              type: 'jsxElement',
              value: `
                <${this.runtimeAlias}.Placeholder prop=${JSON.stringify(prop)}>
                  ${existingProp ? this.renderJsxContent(existingProp) : ''}
                </${this.runtimeAlias}.Placeholder>
              `,
            };
          }
        }
      }
    }

    return result;
  }

  renderNode(node: studioDom.StudioElementNode | studioDom.StudioPageNode): PropExpression {
    const component = this.getComponentDefinition(node);
    if (!component) {
      return {
        type: 'expression',
        value: 'null',
      };
    }

    const nodeChildren = this.renderNodeChildren(node);
    const resolvedProps = this.resolveProps(node, nodeChildren);
    const rendered = component.render(this, resolvedProps);

    // TODO: We may not need the `component` prop anymore. Remove?
    return {
      type: 'jsxElement',
      value: this.editor
        ? `
          <${this.runtimeAlias}.RuntimeStudioNode nodeId="${node.id}">
            ${rendered}
          </${this.runtimeAlias}.RuntimeStudioNode>
        `
        : rendered,
    };
  }

  /**
   * Renders a node to a string that can be inlined as the return value of a React component
   * @example
   * `function Hello () {
   *   return ${RESULT};
   * }`
   */
  renderRoot(node: studioDom.StudioPageNode): string {
    const expr = this.renderNode(node);
    return this.renderJsExpression(expr);
  }

  /**
   * Renders resolved properties to a string that can be inlined as JSX attrinutes
   * @example `<Hello ${RESULT} />`
   */
  renderProps(resolvedProps: ResolvedProps): string {
    return (Object.entries(resolvedProps) as ExactEntriesOf<ResolvedProps>)
      .map(([name, expr]) => {
        if (!expr) {
          return '';
        }
        if (name === '$spread') {
          return expr;
        }
        return `${name}={${this.renderJsExpression(expr)}}`;
      })
      .join(' ');
  }

  /**
   * Renders resolved properties to a string that can be inlined as a JS object
   * @example
   *     `const hello = ${RESULT}`;
   *     // "const hello = { foo: 'bar' }"
   */
  renderPropsAsObject(resolvedProps: ResolvedProps): string {
    const keyValuePairs = (Object.entries(resolvedProps) as ExactEntriesOf<ResolvedProps>).map(
      ([name, expr]) => {
        if (!expr) {
          return '';
        }
        if (name === '$spread') {
          return expr;
        }
        return `${name}: ${this.renderJsExpression(expr)}`;
      },
    );
    return `{${keyValuePairs.join(', ')}}`;
  }

  /**
   * Renders an expression to a string that can be used as a javascript
   * expression. e.g. as the RHS of an assignment statement
   * @example `const hello = ${RESULT}`
   */
  // eslint-disable-next-line class-methods-use-this
  renderJsExpression(expr?: PropExpression): string {
    if (!expr) {
      return 'undefined';
    }
    if (expr.type === 'jsxFragment') {
      return `<>${expr.value}</>`;
    }
    return expr.value;
  }

  /**
   * Renders an expression to a string that can be inlined as children in
   * a JSX element.
   * @example `<Hello>${RESULT}</Hello>`
   */
  renderJsxContent(expr?: PropExpression): string {
    if (!expr) {
      return '';
    }
    if (expr.type === 'jsxElement' || expr.type === 'jsxFragment') {
      return expr.value;
    }
    return `{${this.renderJsExpression(expr)}}`;
  }

  /**
   * Adds an import to the page module. Returns an identifier that's based on [suggestedName] that can
   * be used to reference the import.
   */
  addImport(
    source: string,
    imported: '*' | 'default' | string,
    suggestedName: string = imported,
  ): string {
    return this.imports.add(source, imported, suggestedName);
  }

  renderStateHooks(): string {
    return Object.values(this.useStateHooks)
      .map((state) => {
        if (!state) {
          return '';
        }
        const defaultValue = JSON.stringify(state.defaultValue);
        return `const [${state.state}, ${state.setState}] = ${this.reactAlias}.useState(${defaultValue});`;
      })
      .join('\n');
  }

  renderDerivedStateHooks(): string {
    return Object.entries(this.useMemoHooks)
      .map(([nodeId, stateVar]) => {
        if (stateVar) {
          const node = studioDom.getNode(this.dom, nodeId as NodeId);
          studioDom.assertIsDerivedState(node);
          const { $spread, ...resolvedProps } = this.resolveProps(node, {});
          const params = this.renderPropsAsObject(resolvedProps);
          const depsArray = Object.values(resolvedProps).map((resolvedProp) =>
            this.renderJsExpression(resolvedProp),
          );
          const derivedStateGetter = this.addImport(
            `../derivedState/${node.id}.ts`,
            'default',
            node.name,
          );
          return `const ${stateVar} = React.useMemo(() => ${derivedStateGetter}(${params}), [${depsArray.join(
            ', ',
          )}])`;
        }
        return '';
      })
      .join('\n');
  }

  renderDataLoaderHooks(): string {
    if (this.dataLoaders.length <= 0) {
      return '';
    }

    const useDataQuery = this.addImport('@mui/studio-core', 'useDataQuery', 'useDataQuery');
    return this.dataLoaders
      .map(
        ({ queryId, variable }) =>
          `const ${variable} = ${useDataQuery}(${JSON.stringify(queryId)});`,
      )
      .join('\n');
  }

  render() {
    this.collectAllState();
    const root: string = this.renderRoot(this.page);
    const stateHooks = this.renderStateHooks();
    const derivedStateHooks = this.renderDerivedStateHooks();
    const dataQueryHooks = this.renderDataLoaderHooks();

    this.imports.seal();

    const imports = this.imports.render();

    return `
      ${imports}

      export default function App () {
        ${stateHooks}
        ${dataQueryHooks}
        ${derivedStateHooks}
        return (
          ${root}
        );
      }
    `;
  }
}

export default function renderPageCode(
  dom: studioDom.StudioDom,
  pageNodeId: NodeId,
  configInit: Partial<RenderPageConfig> = {},
) {
  const config: RenderPageConfig = {
    editor: false,
    pretty: false,
    ...configInit,
  };

  const page = studioDom.getNode(dom, pageNodeId);
  studioDom.assertIsPage(page);

  const ctx = new Context(dom, page, config);
  let code: string = ctx.render();

  if (config.pretty) {
    code = prettier.format(code, {
      parser: 'babel-ts',
      plugins: [parserBabel],
    });
  }

  return { code };
}