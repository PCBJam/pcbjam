import { Page, Locator, expect as baseExpect } from '@playwright/test';
import * as fs from 'fs';

export interface WxElement {
  id: string;
  label: string;
  name: string;
  typeName: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  parentId: string | null;
  visible: boolean;
  enabled: boolean;
  lastUpdated: number;
}

export interface FindOptions {
  visible?: boolean;
  enabled?: boolean;
  exact?: boolean;
  type?: string;
  parent?: string;
}

export interface FindFilter extends FindOptions {
  label?: string;
  name?: string;
}

export interface RegistryStats {
  total: number;
  byType: Record<string, number>;
}

export interface WxRenderedElement {
  id: string;
  parentId: string;
  elementType: 'tool' | 'menuitem' | 'sash' | 'auipart' | 'tab' | 'gridcell' | 'listitem' | 'datecell' | 'treeitem' | 'dataviewitem' | 'proprow' | 'listboxitem' | 'spinbutton' | 'slider' | 'slidertrack' | 'textctrl' | 'combobutton' | 'combotextarea' | 'searchctrl' | 'searchbutton' | 'columnheader' | 'styledtext';
  subType: string;
  label: string;
  tooltip: string;
  screenX: number;
  screenY: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  enabled: boolean;
  index: number;
  lastUpdated: number;
}

export interface RenderedFindOptions {
  enabled?: boolean;
  elementType?: string;
  subType?: string;
  parentId?: string;
  exact?: boolean;
}

export interface WxElementRegistry {
  elements: Map<string, WxElement>;
  version: number;
  register(id: string, info: WxElement): void;
  update(id: string, updates: Partial<WxElement>): void;
  unregister(id: string): void;
  findByLabel(label: string, options?: FindOptions): WxElement[];
  findByName(name: string, options?: FindOptions): WxElement[];
  findByType(typeName: string, options?: FindOptions): WxElement[];
  findAll(filter?: FindFilter): WxElement[];
  getElement(id: string): WxElement | null;
  dump(): void;
  getStats(): RegistryStats;
  // Rendered elements support
  renderedElements?: Map<string, WxRenderedElement>;
  renderedVersion?: number;
  findRenderedByLabel?(label: string, options?: RenderedFindOptions): WxRenderedElement[];
  findRenderedByType?(elementType: string, options?: RenderedFindOptions): WxRenderedElement[];
  findRenderedByParent?(parentId: string, options?: RenderedFindOptions): WxRenderedElement[];
  findAllRendered?(filter?: RenderedFindOptions & { label?: string }): WxRenderedElement[];
  dumpRendered?(): void;
  getRenderedStats?(): RegistryStats;
}

declare global {
  interface Window {
    wxElementRegistry?: WxElementRegistry;
  }
}

/**
 * Wait for element registry to be available
 */
export async function waitForRegistry(page: Page, timeout = 5000): Promise<boolean> {
  try {
    await page.waitForFunction(
      () => typeof window.wxElementRegistry !== 'undefined',
      { timeout }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Find element by label text
 */
export async function findByLabel(
  page: Page,
  label: string,
  options: FindOptions = {}
): Promise<WxElement | null> {
  const elements = await page.evaluate(
    ([label, opts]: [string, FindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry) return [];
      return registry.findByLabel(label, opts);
    },
    [label, options] as [string, FindOptions]
  );
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Find all elements by label text
 */
export async function findAllByLabel(
  page: Page,
  label: string,
  options: FindOptions = {}
): Promise<WxElement[]> {
  return page.evaluate(
    ([label, opts]: [string, FindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry) return [];
      return registry.findByLabel(label, opts);
    },
    [label, options] as [string, FindOptions]
  );
}

/**
 * Find element by name
 */
export async function findByName(
  page: Page,
  name: string,
  options: FindOptions = {}
): Promise<WxElement | null> {
  const elements = await page.evaluate(
    ([name, opts]: [string, FindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry) return [];
      return registry.findByName(name, opts);
    },
    [name, options] as [string, FindOptions]
  );
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Find elements by type name (e.g., "wxButton", "wxTextCtrl")
 */
export async function findByType(
  page: Page,
  typeName: string,
  options: FindOptions = {}
): Promise<WxElement[]> {
  return page.evaluate(
    ([typeName, opts]: [string, FindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry) return [];
      return registry.findByType(typeName, opts);
    },
    [typeName, options] as [string, FindOptions]
  );
}

/**
 * Find all elements matching filter
 */
export async function findAll(
  page: Page,
  filter: FindFilter = {}
): Promise<WxElement[]> {
  return page.evaluate(
    (filter: FindFilter) => {
      const registry = window.wxElementRegistry;
      if (!registry) return [];
      return registry.findAll(filter);
    },
    filter
  );
}

/**
 * Click on an element by label
 */
export async function clickByLabel(
  page: Page,
  label: string,
  options: FindOptions = {}
): Promise<boolean> {
  const element = await findByLabel(page, label, options);
  if (!element) {
    console.warn(`Element with label "${label}" not found`);
    return false;
  }

  await page.mouse.click(element.centerX, element.centerY);
  return true;
}

/**
 * Click on an element by name
 */
export async function clickByName(
  page: Page,
  name: string,
  options: FindOptions = {}
): Promise<boolean> {
  const element = await findByName(page, name, options);
  if (!element) {
    console.warn(`Element with name "${name}" not found`);
    return false;
  }

  await page.mouse.click(element.centerX, element.centerY);
  return true;
}

/**
 * Get element position for manual clicking (returns screen coords)
 */
export async function getElementPosition(
  page: Page,
  labelOrName: string,
  options: FindOptions = {}
): Promise<{ x: number; y: number } | null> {
  // Try label first, then name
  let element = await findByLabel(page, labelOrName, options);
  if (!element) {
    element = await findByName(page, labelOrName, options);
  }
  if (!element) return null;

  return { x: element.centerX, y: element.centerY };
}

/**
 * Dump all elements to console (for debugging)
 */
export async function dumpElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (registry) {
      registry.dump();
    } else {
      console.log('[wxElementRegistry] Not initialized');
    }
  });
}

/**
 * Get registry statistics
 */
export async function getRegistryStats(page: Page): Promise<RegistryStats | null> {
  return page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (!registry) return null;
    return registry.getStats();
  });
}

/**
 * Wait for an element to appear by label
 */
export async function waitForElement(
  page: Page,
  label: string,
  options: FindOptions & { timeout?: number } = {}
): Promise<WxElement | null> {
  const timeout = options.timeout || 5000;
  const { timeout: _, ...findOptions } = options;

  try {
    await page.waitForFunction(
      ([label, opts]: [string, FindOptions]) => {
        const registry = window.wxElementRegistry;
        if (!registry) return false;
        const elements = registry.findByLabel(label, opts);
        return elements.length > 0;
      },
      [label, findOptions] as [string, FindOptions],
      { timeout }
    );
    return findByLabel(page, label, findOptions);
  } catch {
    return null;
  }
}

// ============================================================================
// Rendered Elements (toolbar tools, menu items, splitter sashes, AUI parts)
// ============================================================================

/**
 * Find rendered element by label (e.g., toolbar tool "New", menu item "File")
 */
export async function findRenderedByLabel(
  page: Page,
  label: string,
  options: RenderedFindOptions = {}
): Promise<WxRenderedElement | null> {
  const elements = await page.evaluate(
    ([label, opts]: [string, RenderedFindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry || !registry.findRenderedByLabel) return [];
      return registry.findRenderedByLabel(label, opts);
    },
    [label, options] as [string, RenderedFindOptions]
  );
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Find all rendered elements by label
 */
export async function findAllRenderedByLabel(
  page: Page,
  label: string,
  options: RenderedFindOptions = {}
): Promise<WxRenderedElement[]> {
  return page.evaluate(
    ([label, opts]: [string, RenderedFindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry || !registry.findRenderedByLabel) return [];
      return registry.findRenderedByLabel(label, opts);
    },
    [label, options] as [string, RenderedFindOptions]
  );
}

/**
 * Find all rendered elements of a type (tool, menuitem, sash, auipart)
 */
export async function findRenderedByType(
  page: Page,
  elementType: string,
  options: RenderedFindOptions = {}
): Promise<WxRenderedElement[]> {
  return page.evaluate(
    ([type, opts]: [string, RenderedFindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry || !registry.findRenderedByType) return [];
      return registry.findRenderedByType(type, opts);
    },
    [elementType, options] as [string, RenderedFindOptions]
  );
}

/**
 * Find rendered element by tooltip
 */
export async function findByTooltip(
  page: Page,
  tooltip: string,
  options: RenderedFindOptions = {}
): Promise<WxRenderedElement | null> {
  const elements = await page.evaluate(
    ([tooltip, opts]: [string, RenderedFindOptions]) => {
      const registry = window.wxElementRegistry;
      if (!registry || !registry.findAllRendered) return [];
      // Find all rendered elements and filter by tooltip
      const all = registry.findAllRendered(opts);
      return all.filter(e => e.tooltip && e.tooltip.includes(tooltip));
    },
    [tooltip, options] as [string, RenderedFindOptions]
  );
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Click on a rendered element by tooltip
 */
export async function clickByTooltip(
  page: Page,
  tooltip: string,
  options: RenderedFindOptions = {}
): Promise<boolean> {
  const element = await findByTooltip(page, tooltip, options);
  if (!element) {
    console.warn(`Element with tooltip "${tooltip}" not found`);
    return false;
  }
  if (!element.enabled) {
    console.warn(`Element with tooltip "${tooltip}" is disabled`);
    return false;
  }
  await page.mouse.click(element.centerX, element.centerY);
  return true;
}

/**
 * Click on a toolbar tool by label or tooltip
 */
export async function clickToolbarTool(
  page: Page,
  label: string
): Promise<boolean> {
  const tool = await findRenderedByLabel(page, label, { elementType: 'tool' });
  if (!tool) {
    console.warn(`Toolbar tool "${label}" not found`);
    return false;
  }
  if (!tool.enabled) {
    console.warn(`Toolbar tool "${label}" is disabled`);
    return false;
  }
  await page.mouse.click(tool.centerX, tool.centerY);
  return true;
}

/**
 * Click on a menu bar item by label
 */
export async function clickMenuBarItem(
  page: Page,
  label: string
): Promise<boolean> {
  const menuItem = await findRenderedByLabel(page, label, {
    elementType: 'menuitem',
    subType: 'menubar'
  });
  if (!menuItem) {
    console.warn(`Menu bar item "${label}" not found`);
    return false;
  }
  if (!menuItem.enabled) {
    console.warn(`Menu bar item "${label}" is disabled`);
    return false;
  }
  await page.mouse.click(menuItem.centerX, menuItem.centerY);
  return true;
}

/**
 * Click on a popup menu item by label
 */
export async function clickMenuItem(
  page: Page,
  label: string
): Promise<boolean> {
  const menuItem = await findRenderedByLabel(page, label, {
    elementType: 'menuitem'
  });
  if (!menuItem) {
    console.warn(`Menu item "${label}" not found`);
    return false;
  }
  if (!menuItem.enabled) {
    console.warn(`Menu item "${label}" is disabled`);
    return false;
  }
  await page.mouse.click(menuItem.centerX, menuItem.centerY);
  return true;
}

/**
 * Get splitter sash element
 */
export async function getSplitterSash(
  page: Page,
  parentId?: string
): Promise<WxRenderedElement | null> {
  const options: RenderedFindOptions = {};
  if (parentId) options.parentId = parentId;

  const sashes = await findRenderedByType(page, 'sash', options);
  return sashes.length > 0 ? sashes[0] : null;
}

/**
 * Click on an AUI pane button (close, pin, maximize)
 */
export async function clickAuiButton(
  page: Page,
  buttonType: 'close' | 'pin' | 'maximize',
  paneCaption?: string
): Promise<boolean> {
  const options: RenderedFindOptions = {
    elementType: 'auipart',
    subType: buttonType
  };

  let button: WxRenderedElement | null = null;

  if (paneCaption) {
    // Find the specific pane first, then find the button by parent
    const caption = await findRenderedByLabel(page, paneCaption, {
      elementType: 'auipart',
      subType: 'caption'
    });
    if (caption) {
      // Button index is based on pane index
      const paneIndex = caption.index;
      const buttons = await findRenderedByType(page, 'auipart', { subType: buttonType });
      button = buttons.find(b => Math.floor(b.index / 10) === paneIndex) || null;
    }
  } else {
    // Just find the first button of this type
    const buttons = await findRenderedByType(page, 'auipart', options);
    button = buttons.length > 0 ? buttons[0] : null;
  }

  if (!button) {
    console.warn(`AUI ${buttonType} button not found`);
    return false;
  }

  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Find an AUI pane content area by panel caption
 */
export async function findAuiPaneContent(
  page: Page,
  paneCaption: string
): Promise<WxRenderedElement | null> {
  const contents = await findRenderedByType(page, 'auipart', { subType: 'content' });
  return contents.find(c => c.label === paneCaption) || null;
}

/**
 * Click on an AUI pane content area by panel caption
 */
export async function clickAuiPaneContent(
  page: Page,
  paneCaption: string
): Promise<boolean> {
  const content = await findAuiPaneContent(page, paneCaption);
  if (!content) {
    console.warn(`AUI pane content "${paneCaption}" not found`);
    return false;
  }
  await page.mouse.click(content.centerX, content.centerY);
  return true;
}

/**
 * Get all AUI pane content areas
 */
export async function findAllAuiPaneContents(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'auipart', { subType: 'content' });
}

/**
 * Click on a rendered element by label (searches all types)
 */
export async function clickRenderedByLabel(
  page: Page,
  label: string,
  options: RenderedFindOptions = {}
): Promise<boolean> {
  const element = await findRenderedByLabel(page, label, options);
  if (!element) {
    console.warn(`Rendered element "${label}" not found`);
    return false;
  }
  if (!element.enabled) {
    console.warn(`Rendered element "${label}" is disabled`);
    return false;
  }
  await page.mouse.click(element.centerX, element.centerY);
  return true;
}

/**
 * Dump all rendered elements to console (for debugging)
 */
export async function dumpRenderedElements(page: Page): Promise<void> {
  await page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (registry && registry.dumpRendered) {
      registry.dumpRendered();
    } else {
      console.log('[wxElementRegistry] Rendered elements not available');
    }
  });
}

/**
 * Get rendered elements statistics
 */
export async function getRenderedStats(page: Page): Promise<RegistryStats | null> {
  return page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (!registry || !registry.getRenderedStats) return null;
    return registry.getRenderedStats();
  });
}

// ============================================================================
// Grid Cell Helpers
// ============================================================================

/**
 * Find a grid cell by row and column
 */
export async function findGridCell(
  page: Page,
  row: number,
  col: number
): Promise<WxRenderedElement | null> {
  const elements = await page.evaluate(
    ([row, col]: [number, number]) => {
      const registry = window.wxElementRegistry;
      if (!registry || !registry.findAllRendered) return [];
      const allCells = registry.findAllRendered({}).filter(
        e => e.elementType === 'gridcell' && e.tooltip === `Row ${row}, Col ${col}`
      );
      return allCells;
    },
    [row, col] as [number, number]
  );
  return elements.length > 0 ? elements[0] : null;
}

/**
 * Find a grid cell by its label/value
 */
export async function findGridCellByLabel(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'gridcell' });
}

/**
 * Click on a grid cell by row and column
 */
export async function clickGridCell(
  page: Page,
  row: number,
  col: number
): Promise<boolean> {
  const cell = await findGridCell(page, row, col);
  if (!cell) {
    console.warn(`Grid cell at row ${row}, col ${col} not found`);
    return false;
  }
  await page.mouse.click(cell.centerX, cell.centerY);
  return true;
}

/**
 * Click on a grid cell by its label/value
 */
export async function clickGridCellByLabel(
  page: Page,
  label: string
): Promise<boolean> {
  const cell = await findGridCellByLabel(page, label);
  if (!cell) {
    console.warn(`Grid cell with label "${label}" not found`);
    return false;
  }
  await page.mouse.click(cell.centerX, cell.centerY);
  return true;
}

/**
 * Get all grid cells
 */
export async function findAllGridCells(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'gridcell');
}

// ============================================================================
// List Item Helpers
// ============================================================================

/**
 * Find a list item by its label
 */
export async function findListItem(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'listitem' });
}

/**
 * Find a list item by row index
 */
export async function findListItemByIndex(
  page: Page,
  index: number
): Promise<WxRenderedElement | null> {
  const items = await findRenderedByType(page, 'listitem');
  return items.find(item => item.index === index) || null;
}

/**
 * Click on a list item by label
 */
export async function clickListItem(
  page: Page,
  label: string
): Promise<boolean> {
  const item = await findListItem(page, label);
  if (!item) {
    console.warn(`List item "${label}" not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Click on a list item by row index
 */
export async function clickListItemByIndex(
  page: Page,
  index: number
): Promise<boolean> {
  const item = await findListItemByIndex(page, index);
  if (!item) {
    console.warn(`List item at index ${index} not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Get all list items
 */
export async function findAllListItems(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'listitem');
}

// ============================================================================
// Tab Helpers
// ============================================================================

/**
 * Find a tab by its label
 */
export async function findTab(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'tab' });
}

/**
 * Click on a tab by label
 */
export async function clickTab(
  page: Page,
  label: string
): Promise<boolean> {
  // Clicking a tab too fast (e.g. immediately after a burst of mouse events)
  // can be dropped before the notebook processes the page change. Re-click and
  // verify the selection actually switched, retrying a few times.
  const maxAttempts = 4;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const tab = await findTab(page, label);
    if (!tab) {
      console.warn(`Tab "${label}" not found`);
      return false;
    }

    // Already selected (e.g. a previous attempt registered late) -> done.
    const selectedBefore = await findSelectedTab(page);
    if (selectedBefore?.label === label) return true;

    await page.mouse.click(tab.centerX, tab.centerY);

    // Poll until the registry reports this tab as the selected one.
    const switched = await page
      .waitForFunction(
        (expected) => {
          const registry = (window as any).wxElementRegistry;
          if (!registry || !registry.findAllRendered) return false;
          return registry
            .findAllRendered({ label: undefined })
            .some(
              (e: any) =>
                e.elementType === 'tab' &&
                e.subType === 'selected' &&
                e.label === expected
            );
        },
        label,
        { timeout: 1000 }
      )
      .then(() => true)
      .catch(() => false);

    if (switched) return true;
    await page.waitForTimeout(200);
  }

  console.warn(`Tab "${label}" did not become selected after ${maxAttempts} attempts`);
  return false;
}

/**
 * Get all tabs
 */
export async function findAllTabs(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'tab');
}

/**
 * Get the currently selected tab
 */
export async function findSelectedTab(page: Page): Promise<WxRenderedElement | null> {
  const tabs = await page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (!registry || !registry.findAllRendered) return [];
    return registry.findAllRendered({ label: undefined }).filter(
      e => e.elementType === 'tab' && e.subType === 'selected'
    );
  });
  return tabs.length > 0 ? tabs[0] : null;
}

// ============================================================================
// Calendar Date Helpers
// ============================================================================

/**
 * Find a calendar date by day number
 */
export async function findCalendarDate(
  page: Page,
  day: number
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, String(day), { elementType: 'datecell' });
}

/**
 * Click on a calendar date by day number
 */
export async function clickCalendarDate(
  page: Page,
  day: number
): Promise<boolean> {
  const dateCell = await findCalendarDate(page, day);
  if (!dateCell) {
    console.warn(`Calendar date ${day} not found`);
    return false;
  }
  if (!dateCell.enabled) {
    console.warn(`Calendar date ${day} is out of range`);
    return false;
  }
  await page.mouse.click(dateCell.centerX, dateCell.centerY);
  return true;
}

/**
 * Get all calendar date cells
 */
export async function findAllCalendarDates(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'datecell');
}

/**
 * Get the currently selected calendar date
 */
export async function findSelectedCalendarDate(page: Page): Promise<WxRenderedElement | null> {
  const dates = await page.evaluate(() => {
    const registry = window.wxElementRegistry;
    if (!registry || !registry.findAllRendered) return [];
    return registry.findAllRendered({ label: undefined }).filter(
      e => e.elementType === 'datecell' && e.subType === 'selected'
    );
  });
  return dates.length > 0 ? dates[0] : null;
}

// ============================================================================
// Tree Item Helpers
// ============================================================================

/**
 * Find a tree item by its label
 */
export async function findTreeItem(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'treeitem' });
}

/**
 * Click on a tree item by label
 */
export async function clickTreeItem(
  page: Page,
  label: string
): Promise<boolean> {
  const item = await findTreeItem(page, label);
  if (!item) {
    console.warn(`Tree item "${label}" not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Get all tree items
 */
export async function findAllTreeItems(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'treeitem');
}

/**
 * Find tree items by state (expanded, collapsed, leaf)
 */
export async function findTreeItemsByState(
  page: Page,
  state: 'expanded' | 'collapsed' | 'leaf'
): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'treeitem', { subType: state });
}

// ============================================================================
// DataView Item Helpers
// ============================================================================

/**
 * Find a dataview item by its label
 */
export async function findDataViewItem(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'dataviewitem' });
}

/**
 * Find a dataview item by row index
 */
export async function findDataViewItemByIndex(
  page: Page,
  index: number
): Promise<WxRenderedElement | null> {
  const items = await findRenderedByType(page, 'dataviewitem');
  return items.find(item => item.index === index) || null;
}

/**
 * Click on a dataview item by label
 */
export async function clickDataViewItem(
  page: Page,
  label: string
): Promise<boolean> {
  const item = await findDataViewItem(page, label);
  if (!item) {
    console.warn(`DataView item "${label}" not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Click on a dataview item by row index
 */
export async function clickDataViewItemByIndex(
  page: Page,
  index: number
): Promise<boolean> {
  const item = await findDataViewItemByIndex(page, index);
  if (!item) {
    console.warn(`DataView item at index ${index} not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Get all dataview items
 */
export async function findAllDataViewItems(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'dataviewitem');
}

// ============================================================================
// Property Grid Helpers
// ============================================================================

/**
 * Find a property row by its label
 */
export async function findPropertyRow(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'proprow' });
}

/**
 * Click on a property row by label
 */
export async function clickPropertyRow(
  page: Page,
  label: string
): Promise<boolean> {
  const row = await findPropertyRow(page, label);
  if (!row) {
    console.warn(`Property row "${label}" not found`);
    return false;
  }
  if (!row.enabled) {
    console.warn(`Property row "${label}" is disabled`);
    return false;
  }
  await page.mouse.click(row.centerX, row.centerY);
  return true;
}

/**
 * Get all property rows
 */
export async function findAllPropertyRows(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'proprow');
}

/**
 * Find property rows by type (category, property, selected, disabled)
 */
export async function findPropertyRowsByType(
  page: Page,
  type: 'category' | 'property' | 'selected' | 'disabled'
): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'proprow', { subType: type });
}

// ============================================================================
// Listbox/Choice Item Helpers (for dropdown lists)
// ============================================================================

/**
 * Find a listbox item by its label
 */
export async function findListboxItem(
  page: Page,
  label: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, label, { elementType: 'listboxitem' });
}

/**
 * Find a listbox item by index
 */
export async function findListboxItemByIndex(
  page: Page,
  index: number
): Promise<WxRenderedElement | null> {
  const items = await findRenderedByType(page, 'listboxitem');
  return items.find(item => item.index === index) || null;
}

/**
 * Click on a listbox item by label (for wxChoice/wxComboBox dropdowns)
 */
export async function clickListboxItem(
  page: Page,
  label: string
): Promise<boolean> {
  const item = await findListboxItem(page, label);
  if (!item) {
    console.warn(`Listbox item "${label}" not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Click on a listbox item by index
 */
export async function clickListboxItemByIndex(
  page: Page,
  index: number
): Promise<boolean> {
  const item = await findListboxItemByIndex(page, index);
  if (!item) {
    console.warn(`Listbox item at index ${index} not found`);
    return false;
  }
  await page.mouse.click(item.centerX, item.centerY);
  return true;
}

/**
 * Get all listbox items
 */
export async function findAllListboxItems(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'listboxitem');
}

// ============================================================================
// Spin Button Helpers
// ============================================================================

/**
 * Find a spin button arrow by type
 */
export async function findSpinButton(
  page: Page,
  arrowType: 'up' | 'down' | 'left' | 'right'
): Promise<WxRenderedElement | null> {
  const buttons = await findRenderedByType(page, 'spinbutton', { subType: arrowType });
  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Click the spin button up arrow (or left for horizontal)
 */
export async function clickSpinUp(page: Page): Promise<boolean> {
  // Try 'up' first (vertical), then 'left' (horizontal)
  let button = await findSpinButton(page, 'up');
  if (!button) {
    button = await findSpinButton(page, 'left');
  }
  if (!button) {
    console.warn('Spin up/left button not found');
    return false;
  }
  if (!button.enabled) {
    console.warn('Spin up/left button is disabled');
    return false;
  }
  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Click the spin button down arrow (or right for horizontal)
 */
export async function clickSpinDown(page: Page): Promise<boolean> {
  // Try 'down' first (vertical), then 'right' (horizontal)
  let button = await findSpinButton(page, 'down');
  if (!button) {
    button = await findSpinButton(page, 'right');
  }
  if (!button) {
    console.warn('Spin down/right button not found');
    return false;
  }
  if (!button.enabled) {
    console.warn('Spin down/right button is disabled');
    return false;
  }
  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Get all spin buttons
 */
export async function findAllSpinButtons(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'spinbutton');
}

// ============================================================================
// Slider Helpers
// ============================================================================

/**
 * Find a slider thumb by name/label
 */
export async function findSlider(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    return findRenderedByLabel(page, name, { elementType: 'slider' });
  }
  const sliders = await findRenderedByType(page, 'slider');
  return sliders.length > 0 ? sliders[0] : null;
}

/**
 * Find a slider track for drag operations
 */
export async function findSliderTrack(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    return findRenderedByLabel(page, name, { elementType: 'slidertrack' });
  }
  const tracks = await findRenderedByType(page, 'slidertrack');
  return tracks.length > 0 ? tracks[0] : null;
}

/**
 * Click on a slider thumb
 */
export async function clickSlider(
  page: Page,
  name?: string
): Promise<boolean> {
  const slider = await findSlider(page, name);
  if (!slider) {
    console.warn(`Slider${name ? ` "${name}"` : ''} not found`);
    return false;
  }
  if (!slider.enabled) {
    console.warn(`Slider${name ? ` "${name}"` : ''} is disabled`);
    return false;
  }
  await page.mouse.click(slider.centerX, slider.centerY);
  return true;
}

/**
 * Drag slider to a position within the track
 * @param position - value between 0 and 1 (0 = min, 1 = max)
 */
export async function dragSliderTo(
  page: Page,
  position: number,
  name?: string
): Promise<boolean> {
  const slider = await findSlider(page, name);
  const track = await findSliderTrack(page, name);
  if (!slider || !track) {
    console.warn(`Slider or track${name ? ` "${name}"` : ''} not found`);
    return false;
  }
  if (!slider.enabled) {
    console.warn(`Slider${name ? ` "${name}"` : ''} is disabled`);
    return false;
  }

  // Clamp position to [0, 1]
  position = Math.max(0, Math.min(1, position));

  // Determine if horizontal or vertical based on track dimensions
  const isHorizontal = track.width > track.height;

  let targetX: number, targetY: number;
  if (isHorizontal) {
    targetX = track.screenX + track.width * position;
    targetY = track.centerY;
  } else {
    targetX = track.centerX;
    // For vertical sliders, 0 is typically at bottom
    targetY = track.screenY + track.height * (1 - position);
  }

  // Drag from current slider position to target
  await page.mouse.move(slider.centerX, slider.centerY);
  await page.mouse.down();
  await page.mouse.move(targetX, targetY);
  await page.mouse.up();
  return true;
}

/**
 * Get all sliders
 */
export async function findAllSliders(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'slider');
}

// ============================================================================
// Text Control Helpers
// ============================================================================

/**
 * Find a text control by name
 */
export async function findTextCtrl(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    return findRenderedByLabel(page, name, { elementType: 'textctrl' });
  }
  const ctrls = await findRenderedByType(page, 'textctrl');
  return ctrls.length > 0 ? ctrls[0] : null;
}

/**
 * Find a singleline text control
 */
export async function findSingleLineTextCtrl(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    const ctrl = await findRenderedByLabel(page, name, { elementType: 'textctrl', subType: 'singleline' });
    return ctrl;
  }
  const ctrls = await findRenderedByType(page, 'textctrl', { subType: 'singleline' });
  return ctrls.length > 0 ? ctrls[0] : null;
}

/**
 * Find a multiline text control
 */
export async function findMultiLineTextCtrl(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    const ctrl = await findRenderedByLabel(page, name, { elementType: 'textctrl', subType: 'multiline' });
    return ctrl;
  }
  const ctrls = await findRenderedByType(page, 'textctrl', { subType: 'multiline' });
  return ctrls.length > 0 ? ctrls[0] : null;
}

/**
 * Click on a text control to focus it
 */
export async function clickTextCtrl(
  page: Page,
  name?: string
): Promise<boolean> {
  const ctrl = await findTextCtrl(page, name);
  if (!ctrl) {
    console.warn(`TextCtrl${name ? ` "${name}"` : ''} not found`);
    return false;
  }
  if (!ctrl.enabled) {
    console.warn(`TextCtrl${name ? ` "${name}"` : ''} is disabled`);
    return false;
  }
  await page.mouse.click(ctrl.centerX, ctrl.centerY);
  return true;
}

/**
 * Get all text controls
 */
export async function findAllTextCtrls(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'textctrl');
}

// ============================================================================
// Combo/Choice Button Helpers
// ============================================================================

/**
 * Find a combo/choice dropdown button
 */
export async function findComboButton(
  page: Page,
  value?: string
): Promise<WxRenderedElement | null> {
  if (value) {
    return findRenderedByLabel(page, value, { elementType: 'combobutton' });
  }
  const buttons = await findRenderedByType(page, 'combobutton');
  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Click on a combo/choice dropdown button to open/close the dropdown
 */
export async function clickComboButton(
  page: Page,
  value?: string
): Promise<boolean> {
  const button = await findComboButton(page, value);
  if (!button) {
    console.warn(`Combo button${value ? ` with value "${value}"` : ''} not found`);
    return false;
  }
  if (!button.enabled) {
    console.warn(`Combo button${value ? ` with value "${value}"` : ''} is disabled`);
    return false;
  }
  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Open a combo/choice dropdown (clicks button if closed)
 */
export async function openComboDropdown(
  page: Page,
  value?: string
): Promise<boolean> {
  const button = await findComboButton(page, value);
  if (!button) {
    console.warn(`Combo button${value ? ` with value "${value}"` : ''} not found`);
    return false;
  }
  // Only click if dropdown is closed
  if (button.subType === 'closed') {
    await page.mouse.click(button.centerX, button.centerY);
  }
  return true;
}

/**
 * Select an item from combo/choice dropdown by label
 * Opens the dropdown if needed, then clicks the item
 */
export async function selectComboItem(
  page: Page,
  itemLabel: string,
  comboValue?: string
): Promise<boolean> {
  // Open the dropdown
  const opened = await openComboDropdown(page, comboValue);
  if (!opened) return false;

  // Wait a bit for dropdown to appear
  await page.waitForTimeout(100);

  // Click the listbox item
  return clickListboxItem(page, itemLabel);
}

/**
 * Get all combo buttons
 */
export async function findAllComboButtons(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'combobutton');
}

// ============================================================================
// Search Control Helpers
// ============================================================================

/**
 * Find a search control text field
 */
export async function findSearchCtrl(
  page: Page,
  hint?: string
): Promise<WxRenderedElement | null> {
  if (hint) {
    return findRenderedByLabel(page, hint, { elementType: 'searchctrl' });
  }
  const ctrls = await findRenderedByType(page, 'searchctrl');
  return ctrls.length > 0 ? ctrls[0] : null;
}

/**
 * Click on a search control to focus it
 */
export async function clickSearchCtrl(
  page: Page,
  hint?: string
): Promise<boolean> {
  const ctrl = await findSearchCtrl(page, hint);
  if (!ctrl) {
    console.warn(`SearchCtrl${hint ? ` "${hint}"` : ''} not found`);
    return false;
  }
  if (!ctrl.enabled) {
    console.warn(`SearchCtrl${hint ? ` "${hint}"` : ''} is disabled`);
    return false;
  }
  await page.mouse.click(ctrl.centerX, ctrl.centerY);
  return true;
}

/**
 * Find the search button in a search control
 */
export async function findSearchButton(
  page: Page
): Promise<WxRenderedElement | null> {
  const buttons = await findRenderedByType(page, 'searchbutton', { subType: 'search' });
  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find the cancel button in a search control
 */
export async function findSearchCancelButton(
  page: Page
): Promise<WxRenderedElement | null> {
  const buttons = await findRenderedByType(page, 'searchbutton', { subType: 'cancel' });
  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Click the search button
 */
export async function clickSearchButton(page: Page): Promise<boolean> {
  const button = await findSearchButton(page);
  if (!button) {
    console.warn('Search button not found');
    return false;
  }
  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Click the cancel/clear button in a search control
 */
export async function clickSearchCancelButton(page: Page): Promise<boolean> {
  const button = await findSearchCancelButton(page);
  if (!button) {
    console.warn('Search cancel button not found');
    return false;
  }
  await page.mouse.click(button.centerX, button.centerY);
  return true;
}

/**
 * Get all search controls
 */
export async function findAllSearchCtrls(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'searchctrl');
}

// ============================================================================
// Column Header Helpers (for wxDataViewCtrl, wxGrid, etc.)
// ============================================================================

/**
 * Find a column header by its title
 */
export async function findColumnHeader(
  page: Page,
  title: string
): Promise<WxRenderedElement | null> {
  return findRenderedByLabel(page, title, { elementType: 'columnheader' });
}

/**
 * Find a column header by index
 */
export async function findColumnHeaderByIndex(
  page: Page,
  index: number
): Promise<WxRenderedElement | null> {
  const headers = await findRenderedByType(page, 'columnheader');
  return headers.find(h => h.index === index) || null;
}

/**
 * Click on a column header by title (for sorting)
 */
export async function clickColumnHeader(
  page: Page,
  title: string
): Promise<boolean> {
  const header = await findColumnHeader(page, title);
  if (!header) {
    console.warn(`Column header "${title}" not found`);
    return false;
  }
  if (!header.enabled) {
    console.warn(`Column header "${title}" is disabled`);
    return false;
  }
  await page.mouse.click(header.centerX, header.centerY);
  return true;
}

/**
 * Click on a column header by index
 */
export async function clickColumnHeaderByIndex(
  page: Page,
  index: number
): Promise<boolean> {
  const header = await findColumnHeaderByIndex(page, index);
  if (!header) {
    console.warn(`Column header at index ${index} not found`);
    return false;
  }
  if (!header.enabled) {
    console.warn(`Column header at index ${index} is disabled`);
    return false;
  }
  await page.mouse.click(header.centerX, header.centerY);
  return true;
}

/**
 * Get all column headers
 */
export async function findAllColumnHeaders(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'columnheader');
}

/**
 * Find sortable column headers
 */
export async function findSortableColumnHeaders(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'columnheader', { subType: 'sortable' });
}

// ============================================================================
// Styled Text Control (STC) Helpers
// ============================================================================

/**
 * Find a styled text control (code editor) by name
 */
export async function findStyledTextCtrl(
  page: Page,
  name?: string
): Promise<WxRenderedElement | null> {
  if (name) {
    return findRenderedByLabel(page, name, { elementType: 'styledtext' });
  }
  const ctrls = await findRenderedByType(page, 'styledtext');
  return ctrls.length > 0 ? ctrls[0] : null;
}

/**
 * Click on a styled text control to focus it
 */
export async function clickStyledTextCtrl(
  page: Page,
  name?: string
): Promise<boolean> {
  const ctrl = await findStyledTextCtrl(page, name);
  if (!ctrl) {
    console.warn(`StyledTextCtrl${name ? ` "${name}"` : ''} not found`);
    return false;
  }
  if (!ctrl.enabled) {
    console.warn(`StyledTextCtrl${name ? ` "${name}"` : ''} is read-only`);
    return false;
  }
  await page.mouse.click(ctrl.centerX, ctrl.centerY);
  return true;
}

/**
 * Get all styled text controls
 */
export async function findAllStyledTextCtrls(page: Page): Promise<WxRenderedElement[]> {
  return findRenderedByType(page, 'styledtext');
}

// ============================================================================
// Deterministic waits — the "hard" (throw-on-miss) primitives that replace
// waitForTimeout sleeps and `if (element exists)` branches in the specs.
// ============================================================================

/**
 * Poll a page-side predicate until it returns truthy, or throw a readable error.
 *
 * This is the general "loop until something actually happens" utility: it replaces
 * `await page.waitForTimeout(n)` (a blind timer) with a wait on a real condition, and
 * fails LOUDLY with `desc` instead of a bare Playwright timeout — so a test that no
 * longer reaches its expected state reports *what* it was waiting for.
 *
 *   await waitUntil(page, () => !!window.wxElementRegistry, 'registry defined');
 *   await waitUntil(page, (t) => document.title === t, 'title set', { arg: 'KiCad' });
 */
export async function waitUntil<Arg = undefined>(
  page: Page,
  pageFunction: (arg: Arg) => unknown,
  desc: string,
  options: { timeout?: number; arg?: Arg; polling?: number | 'raf' } = {}
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  try {
    await page.waitForFunction(pageFunction, options.arg as Arg, {
      timeout,
      polling: options.polling ?? 'raf',
    });
  } catch {
    throw new Error(`waitUntil: timed out after ${timeout}ms waiting for: ${desc}`);
  }
}

/**
 * Wait until a KiCad/wx editor app is interactive: the emscripten canvas is visible,
 * the element registry is populated, and at least one toolbar has been laid out.
 *
 * App-agnostic (no app-specific frame name) so it can gate every editor spec. Replaces
 * the per-spec `completeWizard()` copies and their fixed 1500–2500ms "let it settle"
 * sleeps — the seeded config already skips the first-run wizard, so readiness is purely
 * "is the editor painted and registered".
 */
export async function waitForEditorReady(
  page: Page,
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? 90000;

  await page.locator('#canvas').waitFor({ state: 'visible', timeout });

  await waitUntil(
    page,
    () => {
      const r = window.wxElementRegistry;
      if (!r) return false;
      const visible = r.findAll({ visible: true });
      const hasToolbar = visible.some((el) => /ToolBar/.test(el.typeName));
      return visible.length > 10 && hasToolbar;
    },
    'editor registry populated + a toolbar laid out',
    { timeout }
  );
}

/**
 * Wait for a rendered element (menu item, toolbar tool, …) to appear, then return it;
 * throw if it never appears. The throwing counterpart to findRenderedByLabel — use it to
 * replace `await page.waitForTimeout(n)` before reading/clicking a popup that renders async.
 */
export async function waitForRenderedByLabel(
  page: Page,
  label: string,
  options: RenderedFindOptions & { timeout?: number } = {}
): Promise<WxRenderedElement> {
  const timeout = options.timeout ?? 15000;
  const { timeout: _t, ...find } = options;
  await waitUntil(
    page,
    ([label, opts]: [string, RenderedFindOptions]) => {
      const r = window.wxElementRegistry;
      if (!r || !r.findRenderedByLabel) return false;
      return r.findRenderedByLabel(label, opts).length > 0;
    },
    `rendered element "${label}"`,
    { timeout, arg: [label, find] as [string, RenderedFindOptions] }
  );
  const el = await findRenderedByLabel(page, label, find);
  if (!el) throw new Error(`waitForRenderedByLabel: "${label}" vanished after appearing`);
  return el;
}

/**
 * Wait until a canvas's pixels stop changing across consecutive animation frames —
 * a deterministic "the drawing has settled" signal for interaction specs (drawing a
 * wire, dragging an item) where the visual effect must land before it can be asserted.
 * Replaces fixed post-action sleeps. Works on WebGL canvases: KiCad's GAL sets
 * preserveDrawingBuffer=true, so drawImage() can read the buffer back.
 */
export async function waitForCanvasStable(
  page: Page,
  selector: string,
  options: { stableFrames?: number; timeout?: number; sampleSize?: number } = {}
): Promise<void> {
  const stableFrames = options.stableFrames ?? 3;
  const timeout = options.timeout ?? 15000;
  const sampleSize = options.sampleSize ?? 48;

  // Clear any accumulator left by a previous wait on this selector.
  await page.evaluate((sel) => {
    const w = window as unknown as { __canvasStable?: Record<string, unknown> };
    if (w.__canvasStable) delete w.__canvasStable[sel];
  }, selector);

  await waitUntil(
    page,
    ([sel, need, size]: [string, number, number]) => {
      const w = window as unknown as { __canvasStable?: Record<string, { sig: number; count: number }> };
      const el = document.querySelector(sel) as HTMLCanvasElement | null;
      if (!el) return false;
      const off = document.createElement('canvas');
      off.width = size;
      off.height = size;
      const ctx = off.getContext('2d', { willReadFrequently: true });
      if (!ctx) return false;
      try {
        ctx.drawImage(el, 0, 0, size, size);
      } catch {
        return false; // canvas not yet readable
      }
      const data = ctx.getImageData(0, 0, size, size).data;
      let sig = 0;
      for (let i = 0; i < data.length; i += 4) {
        sig = (sig * 31 + data[i] + data[i + 1] * 7 + data[i + 2] * 13) | 0;
      }
      const store = (w.__canvasStable ??= {});
      const prev = store[sel];
      if (prev && prev.sig === sig) prev.count += 1;
      else store[sel] = { sig, count: 1 };
      return store[sel].count >= need;
    },
    `canvas "${selector}" stable for ${stableFrames} frames`,
    { timeout, arg: [selector, stableFrames, sampleSize] as [string, number, number], polling: 'raf' }
  );
}

// ============================================================================
// Render-settle + capture — feeds the offline tools/screenshots gate
// ============================================================================

/**
 * page.screenshot options we forward, plus stabilization knobs. Every capture is taken at
 * scale:'css' (1:1 CSS pixels, hardcoded below — see SHOT_OPTS), uniformly across both suites, to
 * match the DPR-1 CI Linux baselines and avoid the past device-scale mismatch bug. So there's no
 * per-call `scale`: it's always 'css'.
 */
type StableShotOptions = {
  fullPage?: boolean;
  /** Overall stabilization budget (ms). Animating states never settle: we proceed and capture anyway. */
  timeout?: number;
  /** Consecutive identical frames for the fast (per-rAF) convergence pass. */
  stableFrames?: number;
  /** Wider-spaced confirmations required AFTER fast convergence (each `interval` ms apart), to catch a
   *  slow async repaint that a few ~16ms frames would miss. */
  confirmFrames?: number;
  /** ms between the wide confirmations. */
  interval?: number;
  /** Canvas whose pixels signal render activity (the wx main surface). Default '#canvas'. */
  canvas?: string;
};

/** Screenshot params for the final capture — pinned scale keeps every shot at 1:1 CSS pixels. */
const SHOT_OPTS = { scale: 'css', animations: 'disabled', caret: 'hide' } as const;

/**
 * Wait until the render has SETTLED, then let the caller capture. The "wait" half of
 * toHaveScreenshot, decoupled so pixel COMPARISON stays in the offline tools/screenshots gate
 * (which diffs test-results/ against tests/baseline-screenshots/ on CI's deterministic Linux render).
 *
 * Runs entirely IN-PAGE (one page.evaluate), hashing a 64px downscale of the wx canvas — NO repeated
 * CDP screenshots (an earlier screenshot-probe version saturated CDP on the heavy kicad canvases and
 * timed the whole suite out). Two-phase HYBRID:
 *   1. Fast rAF convergence — hash every animation frame until `stableFrames` are identical (~48ms):
 *      cheap, catches high-frequency motion (animations).
 *   2. Wide confirmation — then re-hash `confirmFrames` times, each `interval` ms apart (~500ms), so a
 *      SLOW async repaint (e.g. a file list arriving after a suspended readdir) that a few 16ms frames
 *      would sail past forces a reset back to phase 1.
 * Resolves once both phases pass, or when `timeout` elapses — genuinely-animating states (timers,
 * mid-slide) never converge and are captured at the deadline, exactly as the old raw screenshots did.
 * With no canvas we just wait `stableFrames` paint frames (the spec's deterministic waits already
 * reached the target state).
 */
export async function waitForRenderStable(page: Page, options: StableShotOptions = {}): Promise<void> {
  await page.evaluate(
    ({ sel, need, confirmN, interval, timeout }: { sel: string; need: number; confirmN: number; interval: number; timeout: number }) =>
      new Promise<void>((resolve) => {
        const el = document.querySelector(sel) as HTMLCanvasElement | null;
        if (!el || typeof el.getContext !== 'function') {
          let i = 0;
          const paint = () => (++i >= need ? resolve() : requestAnimationFrame(paint));
          requestAnimationFrame(paint);
          return;
        }
        const size = 64;
        const off = document.createElement('canvas');
        off.width = size;
        off.height = size;
        const ctx = off.getContext('2d', { willReadFrequently: true });
        const start = performance.now();
        const hash = (): number => {
          try {
            ctx!.drawImage(el, 0, 0, size, size);
            const d = ctx!.getImageData(0, 0, size, size).data;
            let sig = 0;
            for (let i = 0; i < d.length; i += 4) sig = (sig * 31 + d[i] + d[i + 1] * 7 + d[i + 2] * 13) | 0;
            return sig;
          } catch {
            return NaN; // canvas not yet readable
          }
        };
        const expired = () => performance.now() - start > timeout;
        let prev = NaN;
        let stable = 0;
        let confirms = 0;
        // Phase 2: wide-spaced confirmations. A differing/unreadable sample => a slow change is still
        // in flight, so restart the fast pass.
        const confirm = () => {
          if (expired()) return resolve();
          const cur = hash();
          if (cur === prev && !Number.isNaN(cur)) {
            if (++confirms >= confirmN) return resolve();
            setTimeout(confirm, interval);
          } else {
            prev = cur;
            stable = Number.isNaN(cur) ? 0 : 1;
            confirms = 0;
            requestAnimationFrame(fast);
          }
        };
        // Phase 1: fast per-frame convergence.
        const fast = () => {
          if (expired()) return resolve();
          const cur = hash();
          if (cur === prev && !Number.isNaN(cur)) {
            if (++stable >= need) {
              confirms = 0;
              setTimeout(confirm, interval);
              return;
            }
          } else {
            prev = cur;
            stable = Number.isNaN(cur) ? 0 : 1;
          }
          requestAnimationFrame(fast);
        };
        requestAnimationFrame(fast);
      }),
    {
      sel: options.canvas ?? '#canvas',
      need: options.stableFrames ?? 3,
      confirmN: options.confirmFrames ?? 2,
      interval: options.interval ?? 250,
      timeout: options.timeout ?? 3000,
    }
  );
}

/**
 * Engine-scoped path for a gate screenshot: test-results/<engine>/<name>, where <engine> is the
 * running browser family (chromium | firefox | webkit). Every engine gets its OWN namespace so a
 * spec running on two browsers in one invocation can't have the engines overwrite each other's
 * PNG (the old flat test-results/<name> made the surviving file whichever worker wrote last).
 * The offline gate (tools/screenshots) compares each engine against its own committed baselines
 * in tests/baseline-screenshots/<engine>/.
 */
export function shotPath(page: Page, name: string): string {
  const engine = page.context().browser()!.browserType().name();
  const dir = `test-results/${engine}`;
  // page.screenshot creates parent dirs itself, but fs writers (canvas dumps) don't.
  fs.mkdirSync(dir, { recursive: true });
  return `${dir}/${name}`;
}

/**
 * Stabilize the render, then write a raw PNG to test-results/<engine>/<name> for the offline
 * screenshot gate (tools/screenshots/compare.ts vs tests/baseline-screenshots/<engine>/). Drop-in
 * replacement for `expect(page).toHaveScreenshot(name, opts)`: keeps toHaveScreenshot's
 * render-settle but NOT its inline comparison (that's the calibrated offline pipeline's job) nor
 * its per-platform baseline files. Non-asserting — a render regression is caught by
 * `npm run screenshots:check`, not the test. A name containing '/' is used verbatim (for writers
 * outside the gate, e.g. gal-regression outputs).
 */
export async function stableShot(page: Page, name: string, options: StableShotOptions = {}): Promise<void> {
  await waitForRenderStable(page, options);
  await page.screenshot({
    path: name.includes('/') ? name : shotPath(page, name),
    fullPage: options.fullPage ?? false,
    ...SHOT_OPTS,
  });
}

/**
 * Byte-stable screenshot of a locator (or the whole page): capture only once two consecutive
 * screenshots are identical — the same equality a later "pixels restored" poll asserts, so
 * before/after comparisons are self-consistent. Guards against baselining a mid-convergence
 * frame the canvas never shows again. Pass the Page when the settled region must include
 * wx dialogs/popups that render outside #canvas. (Shared by the presence overlay specs and
 * the web gesture/chooser specs.)
 */
export async function settledShot(canvas: Locator | Page, expectImpl: typeof baseExpect = baseExpect): Promise<Buffer> {
  let prev = await canvas.screenshot();
  await expectImpl
    .poll(
      async () => {
        const next = await canvas.screenshot();
        const settled = next.equals(prev);
        prev = next;
        return settled;
      },
      { timeout: 30000, intervals: [250] },
    )
    .toBe(true);
  return prev;
}

// ============================================================================
// Label normalization + app-readiness (shared by the kicad and e2e/widget suites)
// ============================================================================

/**
 * Normalize a wx label / menu item / tooltip for matching: drop the '&' accelerator
 * marker and any trailing "..." / "…" / whitespace, so "Open", "Open...", "Open…" and
 * "&Open..." all compare equal. Lets a spec name the ONE canonical label and match it
 * regardless of the build's ellipsis rendering — replacing "try A, else A…, else A"
 * fallback chains (which silently mask a real label regression).
 */
export function labelBase(s: string | undefined | null): string {
  return (s ?? '').replace(/&/g, '').replace(/[.…\s]+$/u, '').trim();
}

/**
 * Wait until a wx widget-harness app is interactive: the emscripten canvas is visible and
 * the element registry has registered its widgets. The e2e counterpart to
 * waitForEditorReady (no toolbar requirement — widget demos have no toolbar). Replaces the
 * `tryLoadApp()` + fixed 500ms settle + `waitForRegistry()` trio with one deterministic
 * wait that FAILS LOUDLY (not a swallowed boolean). Only for registry-backed harnesses.
 */
export async function waitForWxApp(
  page: Page,
  options: { timeout?: number; selector?: string } = {}
): Promise<void> {
  const timeout = options.timeout ?? 30000;
  const selector = options.selector ?? '#canvas';
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  await waitUntil(
    page,
    () => {
      const r = window.wxElementRegistry;
      return !!r && typeof r.findAll === 'function' && r.findAll({}).length > 0;
    },
    'wx element registry populated',
    { timeout }
  );
}

/**
 * Wait until a registry-LESS wx canvas app (e.g. the drag-drop / GAL harnesses that draw to
 * #canvas but register no widgets) is interactive: the canvas is visible and its pixels have
 * settled. The deterministic counterpart to waitForWxApp for apps whose wxElementRegistry
 * never populates — replaces `tryLoadApp` + a fixed 500ms settle with a real paint-settle.
 */
export async function waitForCanvasApp(
  page: Page,
  options: { timeout?: number; selector?: string } = {}
): Promise<void> {
  const timeout = options.timeout ?? 30000;
  const selector = options.selector ?? '#canvas';
  await page.locator(selector).waitFor({ state: 'visible', timeout });
  await waitForCanvasStable(page, selector, { timeout });
}

/**
 * Wait for a rendered menu item whose text matches `base` (ignoring '&' and a trailing
 * "..."/"…"), then click it; throw if it never appears. Collapses the
 * `clickMenuItem('Open...') || clickMenuItem('Open…') || clickMenuItem('Open')` fallback
 * chains AND the fixed post-menu-open sleep into one deterministic, loud call.
 */
export async function clickMenuItemByText(
  page: Page,
  base: string,
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? 15000;
  const want = labelBase(base);
  // Match an ENABLED menu item (mirrors the old clickMenuItem, which returned false for a
  // present-but-disabled item — so a disabled target still fails loudly).
  await waitUntil(
    page,
    (w: string) => {
      const norm = (s: string) => (s || '').replace(/&/g, '').replace(/[.…\s]+$/u, '').trim();
      const r = window.wxElementRegistry;
      if (!r || !r.findAllRendered) return false;
      return r.findAllRendered({ elementType: 'menuitem' })
        .some((m) => norm(m.label || '') === w && m.enabled !== false);
    },
    `enabled menu item "${base}"`,
    { timeout, arg: want }
  );
  const pos = await page.evaluate((w: string) => {
    const norm = (s: string) => (s || '').replace(/&/g, '').replace(/[.…\s]+$/u, '').trim();
    const r = window.wxElementRegistry!;
    const hit = r.findAllRendered!({ elementType: 'menuitem' })
      .find((m) => norm(m.label || '') === w && m.enabled !== false);
    return hit ? { x: hit.centerX, y: hit.centerY } : null;
  }, want);
  if (!pos) throw new Error(`clickMenuItemByText: "${base}" vanished after appearing`);
  await page.mouse.click(pos.x, pos.y);
}

/**
 * Focus the emscripten canvas by clicking its centre; asserts the canvas is visible and
 * has a layout box (throws loudly) instead of the `if (box) click` defensive skip that was
 * copy-pasted across specs.
 */
export async function focusCanvas(page: Page, selector = '#canvas'): Promise<void> {
  const loc = page.locator(selector);
  await loc.waitFor({ state: 'visible', timeout: 30000 });
  const box = await loc.boundingBox();
  if (!box) throw new Error(`focusCanvas: ${selector} has no bounding box`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
