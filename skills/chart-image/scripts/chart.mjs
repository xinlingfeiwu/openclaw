#!/usr/bin/env node
/**
 * chart.mjs - Generate chart images from data using Vega-Lite
 *
 * Usage:
 *   node chart.mjs --type line --data '[{"x":"10:00","y":25},{"x":"10:30","y":31}]' --output chart.png
 *   node chart.mjs --spec spec.json --output chart.png
 *   echo '{"type":"line","data":[...]}' | node chart.mjs --output chart.png
 *
 * Options:
 *   --type       Chart type: line, bar, area, point (default: line)
 *   --data       JSON array of data points
 *   --spec       Path to full Vega-Lite spec JSON file
 *   --output     Output file path (default: chart.png)
 *   --title      Chart title
 *   --width      Chart width (default: 600)
 *   --height     Chart height (default: 300)
 *   --x-field    X axis field name (default: x)
 *   --y-field    Y axis field name (default: y)
 *   --x-title    X axis title
 *   --y-title    Y axis title
 *   --color      Line/bar color (default: #e63946)
 *   --y-domain   Y axis domain as "min,max" (e.g., "0,100")
 *   --svg        Output SVG instead of PNG
 */

import { writeFileSync, readFileSync } from "fs";
import sharp from "sharp";
import * as vega from "vega";
import * as vegaLite from "vega-lite";

// Show help
function showHelp() {
  console.log(`
chart.mjs - Generate chart images from data using Vega-Lite

USAGE:
  node chart.mjs --type line --data '[{"x":"A","y":10}]' --output chart.png
  node chart.mjs --type bar --data '[...]' --title "Sales" --dark
  cat data.json | node chart.mjs --type area --output out.png

CHART TYPES:
  line          Line chart (default)
  bar           Vertical bar chart
  area          Area chart with fill
  point         Scatter plot
  pie           Pie chart (use --category-field, --y-field)
  donut         Donut chart (pie with hole)
  candlestick   OHLC candlestick (use --open/high/low/close-field)
  heatmap       Heatmap grid (use --color-value-field)

BASIC OPTIONS:
  --data        JSON array of data points (required unless piping)
  --output      Output file path (default: chart.png)
  --title       Chart title
  --subtitle    Chart subtitle
  --width       Chart width in pixels (default: 600)
  --height      Chart height in pixels (default: 300)
  --dark        Dark mode (night-friendly colors)
  --svg         Output SVG instead of PNG

DATA FIELDS:
  --x-field     X axis field name (default: x)
  --y-field     Y axis field name (default: y)
  --x-title     X axis label
  --y-title     Y axis label
  --x-type      X axis type: ordinal, temporal, quantitative

STYLING:
  --color       Primary color (default: #e63946)
  --y-domain    Y axis range as "min,max" (e.g., "0,100")
  --y-format    Y axis format: percent, dollar, compact, integer, decimal2
  --hline       Horizontal line: "value" or "value,color,label"
  --no-grid     Remove gridlines for cleaner look
  --legend      Legend position: top, bottom, left, right, none

ANNOTATIONS:
  --show-change     Show % change from first to last value
  --focus-change    Zoom Y axis to highlight the change
  --focus-recent N  Focus on last N data points
  --show-values     Label min/max values on chart

MULTI-SERIES:
  --series-field    Field to split data into multiple lines
  --color-field     Field for color encoding
  --stacked         Stack bars/areas

SPECIAL CHARTS:
  --sparkline             Tiny 80x20 inline chart, no axes
  --category-field        Category field for pie/donut
  --open/high/low/close-field   Fields for candlestick
  --volume-field          Volume overlay (dual Y axis)
  --color-value-field     Value field for heatmap coloring
  --color-scheme          Color scheme for heatmap (e.g., viridis)

EXAMPLES:
  # Simple line chart
  node chart.mjs --data '[{"x":"Mon","y":10},{"x":"Tue","y":15}]' -o sales.png

  # Dark mode bar chart with title
  node chart.mjs --type bar --data '[...]' --title "Revenue" --dark -o rev.png

  # Time series with percentage Y axis
  node chart.mjs --data '[...]' --x-type temporal --y-format percent -o pct.png

  # Sparkline for inline use
  node chart.mjs --sparkline --data '[{"x":1,"y":10},{"x":2,"y":15}]' -o spark.png
`);
  process.exit(0);
}

// Parse CLI args
function parseArgs(args) {
  const opts = {
    type: "line",
    output: "chart.png",
    width: 600,
    height: 300,
    xField: "x",
    yField: "y",
    color: "#e63946",
    svg: false,
    showChange: false,
    sparkline: false,
  };

  // Support shorthand: "Mon:10,Tue:25,Wed:18" → [{x:"Mon",y:10},...]
  function parseDataArg(str) {
    str = str.trim();
    if (str.startsWith("[") || str.startsWith("{")) return JSON.parse(str);
    // shorthand: key:value,key:value,...
    return str.split(",").map((pair) => {
      const [label, val] = pair.split(":");
      const num = Number(val);
      return { x: label.trim(), y: isNaN(num) ? val.trim() : num };
    });
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--help":
      case "-h":
        showHelp();
        break;
      case "--type":
        opts.type = next;
        i++;
        break;
      case "--data":
        opts.data = parseDataArg(next);
        i++;
        break;
      case "--spec":
        opts.specFile = next;
        i++;
        break;
      case "--output":
        opts.output = next;
        i++;
        break;
      case "--title":
        opts.title = next;
        i++;
        break;
      case "--width":
        opts.width = parseInt(next);
        i++;
        break;
      case "--height":
        opts.height = parseInt(next);
        i++;
        break;
      case "--x-field":
        opts.xField = next;
        i++;
        break;
      case "--y-field":
        opts.yField = next;
        i++;
        break;
      case "--x-title":
        opts.xTitle = next;
        i++;
        break;
      case "--y-title":
        opts.yTitle = next;
        i++;
        break;
      case "--color":
        opts.color = next;
        i++;
        break;
      case "--y-domain":
        opts.yDomain = next.split(",").map(Number);
        i++;
        break;
      case "--svg":
        opts.svg = true;
        break;
      case "--show-change":
        opts.showChange = true;
        break;
      case "--annotation":
        opts.annotation = next;
        i++;
        break;
      case "--focus-change":
        opts.focusChange = true;
        break;
      case "--focus-recent":
        opts.focusRecent = parseInt(next) || 4;
        i++;
        break;
      case "--dark":
        opts.dark = true;
        break;
      case "--show-values":
        opts.showValues = true;
        break;
      case "--sparkline":
        opts.sparkline = true;
        break;
      case "--stacked":
        opts.stacked = true;
        break;
      case "--color-field":
        opts.colorField = next;
        i++;
        break;
      case "--series-field":
        opts.seriesField = next;
        i++;
        break;
      case "--open-field":
        opts.openField = next;
        i++;
        break;
      case "--high-field":
        opts.highField = next;
        i++;
        break;
      case "--low-field":
        opts.lowField = next;
        i++;
        break;
      case "--close-field":
        opts.closeField = next;
        i++;
        break;
      case "--donut":
        opts.donut = true;
        break;
      case "--category-field":
        opts.categoryField = next;
        i++;
        break;
      case "--volume-field":
        opts.volumeField = next;
        i++;
        break;
      case "--volume-color":
        opts.volumeColor = next;
        i++;
        break;
      case "--annotations":
        opts.annotations = JSON.parse(next);
        i++;
        break;
      case "--color-value-field":
        opts.colorValueField = next;
        i++;
        break;
      case "--y-category-field":
        opts.yCategoryField = next;
        i++;
        break;
      case "--color-scheme":
        opts.colorScheme = next;
        i++;
        break;
      case "--x-type":
        opts.xType = next;
        i++;
        break; // ordinal, temporal, quantitative
      case "--hline": {
        // Format: "value" or "value,color" or "value,color,label"
        const parts = next.split(",");
        const hline = { value: parseFloat(parts[0]) };
        if (parts[1]) hline.color = parts[1];
        if (parts[2]) hline.label = parts[2];
        opts.hlines = opts.hlines || [];
        opts.hlines.push(hline);
        i++;
        break;
      }
      case "--y-format":
        opts.yFormat = next;
        i++;
        break; // percent, dollar, compact, or d3-format string
      case "--subtitle":
        opts.subtitle = next;
        i++;
        break;
      case "--no-grid":
        opts.noGrid = true;
        break;
      case "--legend":
        opts.legend = next;
        i++;
        break; // top, bottom, left, right, none
      case "--x-label-angle":
        opts.xLabelAngle = parseFloat(next);
        i++;
        break; // X axis label rotation angle
      case "-o":
        opts.output = next;
        i++;
        break; // Shorthand for --output
    }
  }

  // Sparkline mode: tiny inline chart, no axes/labels
  if (opts.sparkline) {
    opts.width = opts.width === 600 ? 80 : opts.width; // Default 80 unless specified
    opts.height = opts.height === 300 ? 20 : opts.height; // Default 20 unless specified
    opts.noAxes = true;
    opts.title = null; // No title for sparklines
  }

  return opts;
}

// Read from stdin if no data provided
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("readable", () => {
      let chunk;
      while ((chunk = process.stdin.read()) !== null) {
        data += chunk;
      }
    });
    process.stdin.on("end", () => resolve(data));
    // Timeout for non-piped usage
    setTimeout(() => resolve(""), 100);
  });
}

// Resolve y-format shorthand to d3-format string
function resolveYFormat(fmt) {
  if (!fmt) return null;
  const shortcuts = {
    percent: ".1%", // 45.2%
    pct: ".1%",
    dollar: "$,.2f", // $1,234.56
    usd: "$,.2f",
    compact: "~s", // 1.2K, 3.4M
    integer: ",.0f", // 1,234
    decimal2: ",.2f", // 1,234.56
    decimal4: ",.4f", // 0.0003
    scientific: ".2e", // 3.71e-4
  };
  return shortcuts[fmt] || fmt; // Allow raw d3-format strings
}

// Build Vega-Lite spec from options
function buildSpec(opts) {
  // Theme colors
  const theme = opts.dark
    ? {
        bg: "#1a1a2e",
        text: "#e0e0e0",
        grid: opts.noGrid ? "transparent" : "#333355",
        accent: opts.color || "#ff6b6b",
        positive: "#4ade80",
        negative: "#f87171",
      }
    : {
        bg: "#ffffff",
        text: "#333333",
        grid: opts.noGrid ? "transparent" : "#e0e0e0",
        accent: opts.color || "#e63946",
        positive: "#22c55e",
        negative: "#ef4444",
      };

  const markConfig = {
    line: { type: "line", point: true, color: theme.accent, strokeWidth: 2 },
    bar: { type: "bar", color: theme.accent },
    area: { type: "area", color: theme.accent, opacity: 0.7, line: { color: theme.accent } },
    point: { type: "point", color: theme.accent, size: 100 },
    candlestick: null, // Handled separately as composite chart
  };

  // Pie/donut chart
  if (opts.type === "pie" || opts.type === "donut" || opts.donut) {
    const catField = opts.categoryField || opts.xField || "category";
    const valField = opts.yField || "value";
    const innerRadius =
      opts.type === "donut" || opts.donut ? Math.min(opts.width, opts.height) * 0.2 : 0;

    const pieSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 10, top: 10, bottom: 10 },
      data: { values: opts.data },
      mark: {
        type: "arc",
        innerRadius: innerRadius,
        stroke: theme.bg,
        strokeWidth: 2,
      },
      encoding: {
        theta: { field: valField, type: "quantitative", stack: true },
        color: {
          field: catField,
          type: "nominal",
          title: opts.xTitle || catField,
          scale: { scheme: opts.colorScheme || (opts.dark ? "category20" : "category10") },
          legend: { labelColor: theme.text, titleColor: theme.text },
        },
        order: { field: valField, type: "quantitative", sort: "descending" },
      },
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        view: { stroke: null },
      },
    };

    if (opts.title) {
      pieSpec.title = { text: opts.title, anchor: "middle", color: theme.text };
    }

    // Add labels if showValues
    if (opts.showValues) {
      pieSpec.layer = [
        { mark: { type: "arc", innerRadius: innerRadius, stroke: theme.bg, strokeWidth: 2 } },
        {
          mark: {
            type: "text",
            radius: Math.min(opts.width, opts.height) * 0.35,
            fontSize: 12,
            fontWeight: "bold",
          },
          encoding: {
            text: { field: valField, type: "quantitative" },
            color: { value: theme.text },
          },
        },
      ];
      // Move common encodings to top level when using layers
      pieSpec.encoding = {
        theta: { field: valField, type: "quantitative", stack: true },
        color: {
          field: catField,
          type: "nominal",
          title: opts.xTitle || catField,
          scale: { scheme: opts.colorScheme || (opts.dark ? "category20" : "category10") },
          legend: { labelColor: theme.text, titleColor: theme.text },
        },
        order: { field: valField, type: "quantitative", sort: "descending" },
      };
      delete pieSpec.mark;
    }

    return pieSpec;
  }

  // Heatmap chart (rect marks with color encoding)
  if (opts.type === "heatmap") {
    // Expects data with x, y, and value fields
    // x = columns (e.g., day of week, hour)
    // y = rows (e.g., week number, category)
    // value = intensity (color)
    const xField = opts.xField || "x";
    const yField = opts.yCategoryField || opts.yField || "y";
    const valueField = opts.colorValueField || "value";

    // Choose color scheme based on data type and theme
    // Common schemes: blues, greens, reds, viridis, magma, inferno, plasma
    let colorScheme = opts.colorScheme || (opts.dark ? "viridis" : "blues");

    const heatmapSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 10, top: 10, bottom: 10 },
      data: { values: opts.data },
      mark: {
        type: "rect",
        stroke: theme.bg,
        strokeWidth: 1,
      },
      encoding: {
        x: {
          field: xField,
          type: "ordinal",
          title: opts.xTitle || xField,
          axis: {
            labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45,
            labelColor: theme.text,
            titleColor: theme.text,
            domainColor: theme.grid,
          },
        },
        y: {
          field: yField,
          type: "ordinal",
          title: opts.yTitle || yField,
          axis: { labelColor: theme.text, titleColor: theme.text, domainColor: theme.grid },
        },
        color: {
          field: valueField,
          type: "quantitative",
          title: valueField,
          scale: { scheme: colorScheme },
          legend: {
            labelColor: theme.text,
            titleColor: theme.text,
            gradientLength: 150,
          },
        },
      },
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        axis: {
          labelFontSize: 11,
          titleFontSize: 13,
        },
        view: { stroke: null },
      },
    };

    if (opts.title) {
      heatmapSpec.title = { text: opts.title, anchor: "start", color: theme.text };
    }

    // Add value labels if showValues
    if (opts.showValues) {
      heatmapSpec.layer = [
        { mark: { type: "rect", stroke: theme.bg, strokeWidth: 1 } },
        {
          mark: {
            type: "text",
            fontSize: 10,
            fontWeight: "bold",
          },
          encoding: {
            text: { field: valueField, type: "quantitative" },
            color: {
              condition: {
                test: `datum['${valueField}'] > 50`, // Light text on dark cells
                value: theme.bg === "#ffffff" ? "#ffffff" : "#1a1a2e",
              },
              value: theme.text,
            },
          },
        },
      ];
      // Move encodings to top level for layers
      heatmapSpec.encoding = {
        x: heatmapSpec.encoding.x,
        y: heatmapSpec.encoding.y,
        color: heatmapSpec.encoding.color,
      };
      delete heatmapSpec.mark;
    }

    return heatmapSpec;
  }

  // Candlestick chart (OHLC) - composite of rule + bar marks
  if (opts.type === "candlestick") {
    // Expects data with: x, open, high, low, close fields
    const openField = opts.openField || "open";
    const highField = opts.highField || "high";
    const lowField = opts.lowField || "low";
    const closeField = opts.closeField || "close";

    // Add computed "bullish" field to data
    const dataWithDirection = opts.data.map((d) => ({
      ...d,
      _bullish: d[closeField] >= d[openField],
    }));

    const candleSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 10, top: 10, bottom: 10 },
      data: { values: dataWithDirection },
      layer: [
        // Wick (high-low line)
        {
          mark: { type: "rule", strokeWidth: 1 },
          encoding: {
            x: {
              field: opts.xField,
              type: "ordinal",
              axis: { labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45 },
            },
            y: { field: lowField, type: "quantitative", title: "Price" },
            y2: { field: highField },
            color: {
              condition: { test: "datum._bullish", value: theme.positive },
              value: theme.negative,
            },
          },
        },
        // Body (open-close bar)
        {
          mark: { type: "bar", width: { band: 0.6 } },
          encoding: {
            x: { field: opts.xField, type: "ordinal" },
            y: { field: openField, type: "quantitative" },
            y2: { field: closeField },
            color: {
              condition: { test: "datum._bullish", value: theme.positive },
              value: theme.negative,
            },
          },
        },
      ],
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        axis: {
          labelFontSize: 11,
          titleFontSize: 13,
          gridColor: theme.grid,
          labelColor: theme.text,
          titleColor: theme.text,
          domainColor: theme.grid,
        },
        view: { stroke: null },
      },
    };

    if (opts.title) {
      candleSpec.title = { text: opts.title, anchor: "start", color: theme.text };
    }

    if (opts.yDomain) {
      candleSpec.layer[0].encoding.y.scale = { domain: opts.yDomain };
      candleSpec.layer[1].encoding.y.scale = { domain: opts.yDomain };
    }

    return candleSpec;
  }

  // Stacked bar chart
  if (opts.stacked && opts.colorField) {
    const stackedSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 10, top: 10, bottom: 10 },
      data: { values: opts.data },
      mark: { type: "bar" },
      encoding: {
        x: {
          field: opts.xField,
          type: "ordinal",
          title: opts.xTitle || opts.xField,
          axis: { labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45 },
        },
        y: {
          field: opts.yField,
          type: "quantitative",
          title: opts.yTitle || opts.yField,
          stack: "zero",
        },
        color: {
          field: opts.colorField,
          type: "nominal",
          title: opts.colorField,
          scale: { scheme: opts.colorScheme || "category10" },
        },
      },
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        axis: {
          labelFontSize: 11,
          titleFontSize: 13,
          gridColor: theme.grid,
          labelColor: theme.text,
          titleColor: theme.text,
          domainColor: theme.grid,
        },
        legend: {
          labelColor: theme.text,
          titleColor: theme.text,
        },
        view: { stroke: null },
      },
    };

    if (opts.title) {
      stackedSpec.title = { text: opts.title, anchor: "start", color: theme.text };
    }

    return stackedSpec;
  }

  // Multi-series line chart
  if (opts.seriesField && opts.type === "line") {
    const multiSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 10, top: 10, bottom: 10 },
      data: { values: opts.data },
      mark: { type: "line", point: true, strokeWidth: 2 },
      encoding: {
        x: {
          field: opts.xField,
          type: "ordinal",
          title: opts.xTitle || opts.xField,
          axis: { labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45 },
        },
        y: {
          field: opts.yField,
          type: "quantitative",
          title: opts.yTitle || opts.yField,
          scale: opts.yDomain ? { domain: opts.yDomain } : {},
        },
        color: {
          field: opts.seriesField,
          type: "nominal",
          title: opts.seriesField,
          scale: { scheme: opts.colorScheme || "category10" },
        },
      },
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        axis: {
          labelFontSize: 11,
          titleFontSize: 13,
          gridColor: theme.grid,
          labelColor: theme.text,
          titleColor: theme.text,
          domainColor: theme.grid,
        },
        legend: {
          labelColor: theme.text,
          titleColor: theme.text,
        },
        view: { stroke: null },
      },
    };

    if (opts.title) {
      multiSpec.title = { text: opts.title, anchor: "start", color: theme.text };
    }

    return multiSpec;
  }

  // Volume overlay (dual-axis chart with price line + volume bars)
  if (opts.volumeField && opts.data) {
    const volumeColor = opts.volumeColor || (opts.dark ? "#4a5568" : "#cbd5e0");

    // Apply focusRecent if specified
    let chartData = opts.data;
    if (opts.focusRecent && chartData.length > opts.focusRecent) {
      chartData = chartData.slice(-opts.focusRecent);
    }

    // Calculate Y domain for price if focusChange
    let priceYDomain = opts.yDomain;
    if (opts.focusChange && chartData.length >= 2) {
      const values = chartData.map((d) => d[opts.yField]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min;
      const padding = range * 0.5;
      priceYDomain = [Math.max(0, Math.floor(min - padding)), Math.ceil(max + padding)];
    }

    // Calculate change annotation
    let changeText = opts.annotation || null;
    if (opts.showChange && chartData.length >= 2) {
      const first = chartData[0][opts.yField];
      const last = chartData[chartData.length - 1][opts.yField];
      const change = last - first;
      const sign = change >= 0 ? "+" : "";
      changeText = `${sign}${change.toFixed(1)}%`;
    }

    const volumeSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: theme.bg,
      padding: { left: 10, right: 50, top: 10, bottom: 10 }, // Extra right padding for 2nd axis
      data: { values: chartData },
      layer: [
        // Volume bars (behind, on secondary y-axis)
        {
          mark: { type: "bar", color: volumeColor, opacity: 0.4 },
          encoding: {
            x: {
              field: opts.xField,
              type: "ordinal",
              axis: {
                labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45,
                title: opts.xTitle || opts.xField,
              },
            },
            y: {
              field: opts.volumeField,
              type: "quantitative",
              axis: {
                title: "Volume",
                orient: "right",
                titleColor: volumeColor,
                labelColor: volumeColor,
                gridColor: "transparent", // No grid lines for volume
              },
              scale: { zero: true },
            },
          },
        },
        // Price line (front, on primary y-axis)
        {
          mark: { type: "line", point: true, color: theme.accent, strokeWidth: 2 },
          encoding: {
            x: { field: opts.xField, type: "ordinal" },
            y: {
              field: opts.yField,
              type: "quantitative",
              axis: {
                title: opts.yTitle || opts.yField,
                orient: "left",
                gridColor: theme.grid,
              },
              scale: priceYDomain ? { domain: priceYDomain } : {},
            },
          },
        },
      ],
      resolve: {
        scale: { y: "independent" }, // Key: independent Y scales for dual axis
      },
      config: {
        font: "Helvetica, Arial, sans-serif",
        title: { fontSize: 16, fontWeight: "bold", color: theme.text },
        axis: {
          labelFontSize: 11,
          titleFontSize: 13,
          labelColor: theme.text,
          titleColor: theme.text,
          domainColor: theme.grid,
        },
        view: { stroke: null },
      },
    };

    // Add change annotation if requested
    if (changeText && chartData.length >= 1) {
      const lastPoint = chartData[chartData.length - 1];
      const isNegative = changeText.startsWith("-");

      volumeSpec.layer.push({
        mark: {
          type: "text",
          align: "left",
          dx: 8,
          dy: -8,
          fontSize: 18,
          fontWeight: "bold",
          color: isNegative ? theme.positive : theme.negative,
        },
        encoding: {
          x: { datum: lastPoint[opts.xField] },
          y: { datum: lastPoint[opts.yField] },
          text: { value: changeText },
        },
      });
    }

    if (opts.title) {
      volumeSpec.title = { text: opts.title, anchor: "start", color: theme.text };
    }

    return volumeSpec;
  }

  // Calculate change if requested
  let changeText = opts.annotation || null;
  if (opts.showChange && opts.data && opts.data.length >= 2) {
    const first = opts.data[0][opts.yField];
    const last = opts.data[opts.data.length - 1][opts.yField];
    const change = last - first;
    const sign = change >= 0 ? "+" : "";
    changeText = `${sign}${change.toFixed(1)}%`;
  }

  // Focus on recent data points only
  if (opts.focusRecent && opts.data && opts.data.length > opts.focusRecent) {
    opts.data = opts.data.slice(-opts.focusRecent);
  }

  // Focus Y-axis on change (2x scale of the data range)
  if (opts.focusChange && opts.data && opts.data.length >= 2) {
    const values = opts.data.map((d) => d[opts.yField]);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;
    const padding = range * 0.5; // 50% padding on each side = 2x total range
    const yMin = Math.max(0, Math.floor(min - padding));
    const yMax = Math.ceil(max + padding);
    opts.yDomain = [yMin, yMax];
  }

  // Base layer - the main chart
  const xAxisType = opts.xType || "ordinal"; // ordinal (default), temporal, quantitative
  const yFormat = resolveYFormat(opts.yFormat);
  const mainLayer = {
    mark: markConfig[opts.type] || markConfig.line,
    encoding: {
      x: {
        field: opts.xField,
        type: xAxisType,
        title: opts.xTitle || opts.xField,
        axis: { labelAngle: opts.xLabelAngle !== undefined ? opts.xLabelAngle : -45 },
      },
      y: {
        field: opts.yField,
        type: "quantitative",
        title: opts.yTitle || opts.yField,
        ...(yFormat ? { axis: { format: yFormat } } : {}),
      },
    },
  };

  if (opts.yDomain) {
    mainLayer.encoding.y.scale = { domain: opts.yDomain };
  }

  const layers = [mainLayer];

  // Add change annotation on the last point
  if (changeText && opts.data && opts.data.length >= 1) {
    const lastPoint = opts.data[opts.data.length - 1];
    const isNegative = changeText.startsWith("-");

    layers.push({
      mark: {
        type: "text",
        align: "left",
        dx: 8,
        dy: -8,
        fontSize: 18,
        fontWeight: "bold",
        color: isNegative ? theme.positive : theme.negative, // Green for negative (good), red for positive (bad for risk)
      },
      encoding: {
        x: { datum: lastPoint[opts.xField] },
        y: { datum: lastPoint[opts.yField] },
        text: { value: changeText },
      },
    });
  }

  // Add value labels at peak points (min and max)
  if (opts.showValues && opts.data && opts.data.length >= 2) {
    const values = opts.data.map((d) => d[opts.yField]);
    const minVal = Math.min(...values);
    const maxVal = Math.max(...values);
    const minPoint = opts.data.find((d) => d[opts.yField] === minVal);
    const maxPoint = opts.data.find((d) => d[opts.yField] === maxVal);

    // Format value labels using y-format if available
    const fmtVal = (v) => {
      if (!yFormat) return `${v}`;
      // Simple formatting for common cases
      if (yFormat === ".1%") return `${(v * 100).toFixed(1)}%`;
      if (yFormat === "$,.2f")
        return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      if (yFormat === ",.4f") return v.toFixed(4);
      if (yFormat === ".2e") return v.toExponential(2);
      return `${v}`;
    };

    // Max point label (above)
    if (maxPoint) {
      layers.push({
        mark: {
          type: "text",
          align: "center",
          dy: -12,
          fontSize: 13,
          fontWeight: "bold",
          color: theme.text,
        },
        encoding: {
          x: { datum: maxPoint[opts.xField] },
          y: { datum: maxPoint[opts.yField] },
          text: { value: fmtVal(maxVal) },
        },
      });
    }

    // Min point label (below) - only if different from max
    if (minPoint && minVal !== maxVal) {
      layers.push({
        mark: {
          type: "text",
          align: "center",
          dy: 16,
          fontSize: 13,
          fontWeight: "bold",
          color: theme.text,
        },
        encoding: {
          x: { datum: minPoint[opts.xField] },
          y: { datum: minPoint[opts.yField] },
          text: { value: fmtVal(minVal) },
        },
      });
    }
  }

  // Add timeline annotations (vertical lines with labels)
  // Format: --annotations '[{"x":"10:00","label":"Event 1"},{"x":"14:00","label":"Event 2"}]'
  if (opts.annotations && Array.isArray(opts.annotations) && opts.data) {
    const annotationColor = opts.dark ? "#fbbf24" : "#d97706"; // Amber color for visibility

    for (const ann of opts.annotations) {
      const xVal = ann.x || ann[opts.xField];
      const label = ann.label || ann.text || "";

      // Find Y value at this X point for positioning (or use middle of Y range)
      const dataPoint = opts.data.find((d) => d[opts.xField] === xVal);
      const yValues = opts.data.map((d) => d[opts.yField]);
      const yMin = Math.min(...yValues);
      const yMax = Math.max(...yValues);
      const yPos = dataPoint ? dataPoint[opts.yField] : (yMin + yMax) / 2;

      // Vertical rule line
      layers.push({
        mark: {
          type: "rule",
          color: annotationColor,
          strokeWidth: 2,
          strokeDash: [4, 4], // Dashed line
        },
        encoding: {
          x: { datum: xVal },
        },
      });

      // Label above the line
      if (label) {
        layers.push({
          mark: {
            type: "text",
            align: "center",
            baseline: "bottom",
            dy: -5,
            fontSize: 11,
            fontWeight: "bold",
            color: annotationColor,
          },
          encoding: {
            x: { datum: xVal },
            y: { value: 10 }, // Near top of chart
            text: { value: label },
          },
        });
      }
    }
  }

  // Add horizontal reference lines (thresholds, targets, etc.)
  // Format: --hline "value" or --hline "value,color" or --hline "value,color,label"
  if (opts.hlines && opts.hlines.length > 0) {
    for (const hline of opts.hlines) {
      const lineColor = hline.color || (opts.dark ? "#fbbf24" : "#d97706"); // Amber default

      // Horizontal rule
      layers.push({
        mark: {
          type: "rule",
          color: lineColor,
          strokeWidth: 2,
          strokeDash: [6, 3],
        },
        encoding: {
          y: { datum: hline.value },
        },
      });

      // Label on the right side
      if (hline.label) {
        layers.push({
          mark: {
            type: "text",
            align: "right",
            baseline: "middle",
            dx: -5,
            fontSize: 11,
            fontWeight: "bold",
            color: lineColor,
          },
          encoding: {
            x: { value: opts.width - 5 },
            y: { datum: hline.value },
            text: { value: hline.label },
          },
        });
      }
    }
  }

  // Sparkline mode: minimal spec, no axes
  if (opts.sparkline || opts.noAxes) {
    const sparkSpec = {
      $schema: "https://vega.github.io/schema/vega-lite/v5.json",
      width: opts.width,
      height: opts.height,
      background: opts.sparkline ? "transparent" : theme.bg,
      padding: 0,
      autosize: { type: "fit", contains: "padding" },
      data: { values: opts.data },
      mark: {
        type: "line",
        color: theme.accent,
        strokeWidth: opts.sparkline ? 1.5 : 2,
      },
      encoding: {
        x: {
          field: opts.xField,
          type: "ordinal",
          axis: null, // No axis
        },
        y: {
          field: opts.yField,
          type: "quantitative",
          axis: null, // No axis
          scale: opts.yDomain ? { domain: opts.yDomain } : { zero: false },
        },
      },
      config: {
        view: { stroke: null },
      },
    };
    return sparkSpec;
  }

  const spec = {
    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
    width: opts.width,
    height: opts.height,
    background: theme.bg,
    padding: { left: 10, right: 30, top: 10, bottom: 10 },
    data: { values: opts.data },
    layer: layers,
    config: {
      font: "Helvetica, Arial, sans-serif",
      title: { fontSize: 16, fontWeight: "bold", color: theme.text },
      axis: {
        labelFontSize: 11,
        titleFontSize: 13,
        gridColor: theme.grid,
        labelColor: theme.text,
        titleColor: theme.text,
        domainColor: theme.grid,
      },
      view: { stroke: null },
      legend: {
        labelColor: theme.text,
        titleColor: theme.text,
        ...(opts.legend === "none" ? { disable: true } : {}),
        ...(opts.legend && opts.legend !== "none" ? { orient: opts.legend } : {}),
      },
    },
  };

  if (opts.title) {
    spec.title = {
      text: opts.title,
      anchor: "start",
      color: theme.text,
      ...(opts.subtitle
        ? { subtitle: opts.subtitle, subtitleColor: theme.grid, subtitleFontSize: 12 }
        : {}),
    };
  }

  return spec;
}

// Main
async function main() {
  const opts = parseArgs(process.argv.slice(2));

  let spec;

  if (opts.specFile) {
    // Load full spec from file
    spec = JSON.parse(readFileSync(opts.specFile, "utf8"));
  } else if (opts.data) {
    // Build spec from options
    spec = buildSpec(opts);
  } else {
    // Try stdin
    const stdin = await readStdin();
    if (stdin.trim()) {
      const input = JSON.parse(stdin);
      if (input.$schema) {
        // Full spec via stdin
        spec = input;
      } else if (Array.isArray(input)) {
        // Just data array
        opts.data = input;
        spec = buildSpec(opts);
      } else if (input.data) {
        // Simplified format: {type, data, title, ...}
        Object.assign(opts, input);
        if (typeof opts.data === "string") opts.data = JSON.parse(opts.data);
        spec = buildSpec(opts);
      }
    }
  }

  if (!spec || !spec.data?.values?.length) {
    console.error("Error: No data provided. Use --data, --spec, or pipe JSON to stdin.");
    process.exit(1);
  }

  // Compile Vega-Lite to Vega
  const vgSpec = vegaLite.compile(spec).spec;
  const view = new vega.View(vega.parse(vgSpec), { renderer: "none" });

  await view.initialize();

  // Generate SVG
  const svg = await view.toSVG();

  if (opts.svg || opts.output.endsWith(".svg")) {
    writeFileSync(opts.output, svg);
    console.log(`SVG saved to ${opts.output}`);
  } else {
    // Convert SVG to PNG using sharp
    const pngBuffer = await sharp(Buffer.from(svg)).png().toBuffer();

    writeFileSync(opts.output, pngBuffer);
    console.log(`Chart saved to ${opts.output}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
