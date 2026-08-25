import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@punch-bot/tui";
import type { DeliveryQuestion } from "../../../core/delivery.ts";
import { getSelectListTheme, theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const QUESTION_SELECT_LIST_LAYOUT: SelectListLayoutOptions = { minPrimaryColumnWidth: 12, maxPrimaryColumnWidth: 48 };

const OTHER_VALUE = "__other__";

let doneSeq = 0;

export class QuestionSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList | undefined;
	private selectListChildIndex: number | undefined;
	private allItems: SelectItem[];
	private onAnswer: (answer: string) => void;
	private onCancel: () => void;
	private multi = false;
	private doneValue: string;
	private selected: string[] = [];
	private customInputMode = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(question: DeliveryQuestion, onAnswer: (answer: string) => void, onCancel: () => void) {
		super();
		this.onAnswer = onAnswer;
		this.onCancel = onCancel;
		this.multi = question.multi;
		this.doneValue = `__done__${++doneSeq}`;
		const items = question.options.map((option) => ({ value: option, label: option }));
		if (this.multi && items.length > 0) {
			items.push({ value: this.doneValue, label: "Done" });
		}
		if (question.input.length > 0) {
			items.push({ value: OTHER_VALUE, label: "Other…" });
		}
		this.allItems = items;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(question.title || "Question", 0, 0));
		if (question.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(question.description, 0, 0));
		}
		this.addChild(new Spacer(1));
		this.searchInput = new Input();
		this.searchInput.onSubmit = () => {
			const query = this.searchInput.getValue();
			if (this.customInputMode) {
				if (this.multi) {
					this.selected.push(query);
					this.onAnswer(this.selected.join(", "));
				} else {
					this.onAnswer(query);
				}
				return;
			}
			if (items.length > 0 && this.selectList) {
				this.selectList.handleInput("\r");
			} else {
				this.onAnswer(query);
			}
		};
		this.searchInput.onEscape = () => this.onCancel();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		if (items.length > 0) {
			this.selectList = this.buildSelectList(this.allItems);
			this.selectListChildIndex = this.children.length;
			this.addChild(this.selectList);
		} else {
			this.searchInput.focused = true;
		}
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", "  Enter to select · Esc to cancel"), 0, 0));
		this.addChild(new DynamicBorder());
	}

	private buildSelectList(items: SelectItem[], preselect?: string): SelectList {
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme(), QUESTION_SELECT_LIST_LAYOUT);
		const currentIndex = items.findIndex((item) => item.value === preselect);
		if (currentIndex !== -1) list.setSelectedIndex(currentIndex);
		list.onSelect = (item) => {
			if (item.value === OTHER_VALUE) {
				this.customInputMode = true;
				this.searchInput.focused = true;
				this.searchInput.setValue("");
				if (this.selectListChildIndex !== undefined) {
					this.children[this.selectListChildIndex] = new Text(
						theme.fg("dim", "  Type your answer and press Enter"),
						0,
						0,
					);
				}
				this._focused = true;
				return;
			}
			if (item.value === this.doneValue) {
				if (this.selected.length > 0) {
					this.onAnswer(this.selected.join(", "));
				}
				return;
			}
			if (this.multi) {
				const selectedIndex = this.selected.indexOf(item.value);
				if (selectedIndex !== -1) {
					this.selected.splice(selectedIndex, 1);
					item.label = item.label.replace(/^✓ /, "");
				} else {
					this.selected.push(item.value);
					item.label = `✓ ${item.label}`;
				}
				return;
			}
			this.onAnswer(item.value);
		};
		list.onCancel = () => this.onCancel();
		return list;
	}

	private applyFilter(query: string): void {
		if (!this.selectList || this.selectListChildIndex === undefined) return;
		const filtered = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.label} ${item.description ?? ""}`)
			: this.allItems;
		const selectedValue = this.selectList.getSelectedItem()?.value;
		const newList = this.buildSelectList(filtered, selectedValue);
		this.children[this.selectListChildIndex] = newList;
		this.selectList = newList;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (this.customInputMode) {
			this.searchInput.handleInput(keyData);
			return;
		}
		const isNav =
			kb.matches(keyData, "tui.select.up") ||
			kb.matches(keyData, "tui.select.down") ||
			kb.matches(keyData, "tui.select.confirm") ||
			kb.matches(keyData, "tui.select.cancel");
		if (this.selectList && isNav) {
			this.selectList.handleInput(keyData);
			return;
		}
		this.searchInput.handleInput(keyData);
		this.applyFilter(this.searchInput.getValue());
	}

	getSelectList(): SelectList | undefined {
		return this.selectList;
	}
}
