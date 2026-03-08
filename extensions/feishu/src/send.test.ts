import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessageFeishu, splitByTableLimit } from "./send.js";

const { mockClientGet, mockCreateFeishuClient, mockResolveFeishuAccount } = vi.hoisted(() => ({
  mockClientGet: vi.fn(),
  mockCreateFeishuClient: vi.fn(),
  mockResolveFeishuAccount: vi.fn(),
}));

vi.mock("./client.js", () => ({
  createFeishuClient: mockCreateFeishuClient,
}));

vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: mockResolveFeishuAccount,
}));

describe("getMessageFeishu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveFeishuAccount.mockReturnValue({
      accountId: "default",
      configured: true,
    });
    mockCreateFeishuClient.mockReturnValue({
      im: {
        message: {
          get: mockClientGet,
        },
      },
    });
  });

  it("extracts text content from interactive card elements", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            chat_id: "oc_1",
            msg_type: "interactive",
            body: {
              content: JSON.stringify({
                elements: [
                  { tag: "markdown", content: "hello markdown" },
                  { tag: "div", text: { content: "hello div" } },
                ],
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_1",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_1",
        chatId: "oc_1",
        contentType: "interactive",
        content: "hello markdown\nhello div",
      }),
    );
  });

  it("extracts text content from post messages", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_post",
            chat_id: "oc_post",
            msg_type: "post",
            body: {
              content: JSON.stringify({
                zh_cn: {
                  title: "Summary",
                  content: [[{ tag: "text", text: "post body" }]],
                },
              }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_post",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_post",
        chatId: "oc_post",
        contentType: "post",
        content: "Summary\n\npost body",
      }),
    );
  });

  it("returns text placeholder instead of raw JSON for unsupported message types", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_file",
            chat_id: "oc_file",
            msg_type: "file",
            body: {
              content: JSON.stringify({ file_key: "file_v3_123" }),
            },
          },
        ],
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_file",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_file",
        chatId: "oc_file",
        contentType: "file",
        content: "[file message]",
      }),
    );
  });

  it("supports single-object response shape from Feishu API", async () => {
    mockClientGet.mockResolvedValueOnce({
      code: 0,
      data: {
        message_id: "om_single",
        chat_id: "oc_single",
        msg_type: "text",
        body: {
          content: JSON.stringify({ text: "single payload" }),
        },
      },
    });

    const result = await getMessageFeishu({
      cfg: {} as ClawdbotConfig,
      messageId: "om_single",
    });

    expect(result).toEqual(
      expect.objectContaining({
        messageId: "om_single",
        chatId: "oc_single",
        contentType: "text",
        content: "single payload",
      }),
    );
  });
});

describe("splitByTableLimit", () => {
  const table1 = "| A | B |\n|---|---|\n| 1 | 2 |";
  const table2 = "| C | D |\n|---|---|\n| 3 | 4 |";
  const table3 = "| E | F |\n|---|---|\n| 5 | 6 |";
  const table4 = "| G | H |\n|---|---|\n| 7 | 8 |";

  it("returns original text when there are no tables", () => {
    const text = "No tables here.";
    expect(splitByTableLimit(text, 3)).toEqual([text]);
  });

  it("returns original text when tables are within limit", () => {
    const text = `${table1}\n\n${table2}`;
    expect(splitByTableLimit(text, 3)).toEqual([text]);
  });

  it("returns original text when tables exactly equal limit", () => {
    const text = `${table1}\n\n${table2}\n\n${table3}`;
    expect(splitByTableLimit(text, 3)).toEqual([text]);
  });

  it("splits into two segments when tables exceed limit", () => {
    const text = `${table1}\n\n${table2}\n\n${table3}\n\n${table4}`;
    const result = splitByTableLimit(text, 3);
    expect(result).toHaveLength(2);
    // First segment should contain exactly 3 tables
    expect(result[0]).toContain("| A |");
    expect(result[0]).toContain("| C |");
    expect(result[0]).toContain("| E |");
    expect(result[0]).not.toContain("| G |");
    // Second segment should contain the 4th table
    expect(result[1]).toContain("| G |");
  });

  it("handles limit of 1 table per segment", () => {
    const text = `intro\n\n${table1}\n\nmiddle\n\n${table2}\n\nend`;
    const result = splitByTableLimit(text, 1);
    expect(result).toHaveLength(2);
    // intro and middle (before table2) are in the first segment
    expect(result[0]).toContain("intro");
    expect(result[0]).toContain("| A |");
    expect(result[0]).toContain("middle");
    // second segment starts at table2
    expect(result[1]).toContain("| C |");
    expect(result[1]).toContain("end");
  });
});
