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

export class QuestionSelectorComponent extends Container implements Focusable {
	private searchInput: Input;
	private selectList: SelectList | undefined;
	private selectListChildIndex: number | undefined;
	private allItems: SelectItem[];
	private onAnswer: (answer: string) => void;
	private onCancel: () => void;
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
		const items = question.options.map((option) => ({ value: option, label: option }));
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
			if (items.length > 0 && this.selectList) {
				this.selectList.handleInput("\r");
			} else {
				this.onAnswer(query);
			}
		};
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
				this.searchInput.focused = true;
				this.searchInput.setValue("");
				if (this.selectListChildIndex !== undefined) {
					this.children[this.selectListChildIndex] = new Text(
						theme.fg("dim", "  Type your answer and press Enter"),
						0,
						0,
					);
				}
				this._focused = false;
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
