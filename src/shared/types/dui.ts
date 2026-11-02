export interface BtnState {
  uri: string;
  color?: string;
}

export interface BtnImages {
  normal: BtnState;
  hot?: BtnState;
  pushed?: BtnState;
  disabled?: BtnState;
}

export type LayoutNode =
  | { type: "horizontal"; children: LayoutNode[] }
  | { type: "vertical"; children: LayoutNode[] }
  | {
      type: "container";
      width?: number;
      height?: number;
      children: LayoutNode[];
    }
  | { type: "control"; width?: number; height?: number }
  | { type: "button"; width: number; height: number; index: number };

export interface ElementTemplate {
  height: number;
  minWidth: number;
  maxWidth: number;
  layout: LayoutNode;
}
