/**
 * primitives/index.ts — barrel export for SOUP v3 primitive components.
 *
 * Badge (StatusCell + ModeBadge), Button, ActionButton, Card, FormControl, Modal, Pill,
 * Table, Toolbar, LogStream, Drawer, Tabs, Popover, Menu.
 * All consumers import from this barrel; never import from individual files.
 */
export { StatusCell, ModeBadge } from './Badge';
export type { StatusCellProps, ModeBadgeProps } from './Badge';

export { Avatar, AvatarStack } from './Avatar';
export type {
  AvatarProps,
  AvatarStackProps,
  AvatarSize,
  AvatarPresence,
} from './Avatar';

export { Card } from './Card';
export type { CardProps, CardVariant, CardEdge } from './Card';

export { Button } from './Button';
export type { ButtonProps, ButtonVariant, ButtonSize } from './Button';

export { ActionButton } from './ActionButton';
export type { ActionButtonProps } from './ActionButton';

export {
  Field,
  TextInput,
  NumberInput,
  SelectInput,
  FileInput,
  TextArea,
  RadioField,
  CheckboxField,
} from './FormControl';
export type {
  FieldProps,
  TextInputProps,
  NumberInputProps,
  SelectInputProps,
  FileInputProps,
  TextAreaProps,
  RadioFieldProps,
  CheckboxFieldProps,
} from './FormControl';

export { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
export type {
  ModalProps,
  ModalHeaderProps,
  ModalBodyProps,
  ModalFooterProps,
  ModalSize,
} from './Modal';

export { Pill } from './Pill';
export type {
  PillProps,
  PillTone,
  PillSize,
  StaticPillProps,
  InteractivePillProps,
  RemovablePillProps,
} from './Pill';

export {
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  TableEmpty,
  TableError,
  TableLoading,
  EM_DASH,
} from './Table';
export type {
  TableProps,
  TableDensity,
  TableHeaderProps,
  TableHeaderCellProps,
  TableBodyProps,
  TableRowProps,
  TableCellProps,
  TableEmptyProps,
  TableErrorProps,
  TableLoadingProps,
  SortState,
  SortDir,
  RowSeverity,
} from './Table';

export {
  Toolbar,
  ToolbarFilters,
  ToolbarTimeRange,
  ToolbarSearch,
  ToolbarSpring,
} from './Toolbar';
export type {
  ToolbarProps,
  ToolbarFiltersProps,
  ToolbarTimeRangeProps,
  ToolbarSearchProps,
  TimeRangeOption,
} from './Toolbar';

export { LogStream } from './LogStream';
export type { LogStreamProps, LogDensity } from './LogStream';

export {
  Drawer,
  DrawerLayout,
  DrawerHeader,
  DrawerBody,
  DrawerFooter,
} from './Drawer';
export type {
  DrawerProps,
  DrawerPlacement,
  DrawerLayoutProps,
  DrawerHeaderProps,
  DrawerBodyProps,
  DrawerFooterProps,
} from './Drawer';

export { Tabs, Tab, TabPanel } from './Tabs';
export type { TabsProps, TabProps, TabPanelProps } from './Tabs';

export { Popover, popoverOptionId, usePopoverKeyboard } from './Popover';
export type {
  PopoverProps,
  PopoverOption,
  UsePopoverKeyboardOptions,
  UsePopoverKeyboardResult,
} from './Popover';

export { Menu, MenuItem, MenuSection, MenuSeparator } from './Menu';
export type {
  MenuProps,
  MenuItemProps,
  MenuSectionProps,
} from './Menu';
