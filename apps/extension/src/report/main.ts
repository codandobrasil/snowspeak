import { REPORT_STORAGE_KEY, type Report, type ReportItem } from "../sidepanel/report-model";

const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderItem(item: ReportItem): HTMLLIElement {
  const li = document.createElement("li");
  if (item.kind === "suggestion") {
    li.className = "suggestion";
    li.append(element("div", "label", "Sugestão de resposta"), element("p", "en", item.en), element("p", "pt", item.pt));
    return li;
  }
  li.className = `utterance ${item.channel}`;
  const who = element("div", "who");
  who.append(element("span", "name", item.speaker));
  if (item.time) who.append(document.createTextNode(` · ${item.time}`));
  if (item.interrupted) who.append(element("span", "interrupted", "fala interrompida"));
  li.append(who, element("p", "english", item.english));
  if (item.portuguese) li.append(element("p", "portuguese", item.portuguese));
  return li;
}

function render(report: Report): void {
  // O título vira o nome sugerido do arquivo em "Salvar como PDF".
  document.title = report.title;
  byId("date").textContent = report.date;
  byId("start").textContent = report.start;
  byId("end").textContent = report.end;
  byId("duration").textContent = report.duration;
  byId("mode").textContent = report.modeLabel;
  byId("context").textContent = report.context ?? "";
  byId("context-block").hidden = report.context === null;
  byId("job").textContent = report.job ?? "";
  byId("job-block").hidden = report.job === null;
  byId("conversation").replaceChildren(...report.items.map(renderItem));
  byId("empty").hidden = report.items.length > 0;
}

async function main(): Promise<void> {
  const stored = (await chrome.storage.session.get(REPORT_STORAGE_KEY))[REPORT_STORAGE_KEY] as Report | undefined;
  if (!stored) {
    document.querySelector<HTMLElement>(".page")!.hidden = true;
    document.querySelector<HTMLElement>(".toolbar")!.hidden = true;
    byId("missing").hidden = false;
    return;
  }
  render(stored);
  byId<HTMLButtonElement>("print").addEventListener("click", () => window.print());
  // Espera o logo e a diagramação antes de abrir a impressão.
  await Promise.all([...document.images].map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))));
  requestAnimationFrame(() => window.print());
}

void main();
