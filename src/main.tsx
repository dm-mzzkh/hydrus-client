import { render } from "solid-js/web";
import { App } from "./App";
import { applyTheme, loadTheme } from "./theme";
import "./styles.css";

applyTheme(loadTheme()); // до рендера — без вспышки темы

render(() => <App />, document.getElementById("root")!);
