# Harness: the loop -- keep feeding real tool results back into the model.
"""
s01_agent_loop.py - The Agent Loop
This file teaches the smallest useful coding-agent pattern:
    user message
      -> model reply
      -> if tool_use: execute tools
      -> write tool_result back to messages
      -> continue
It intentionally keeps the loop small, but still makes the loop state explicit
so later chapters can grow from the same structure.

【给初学者】核心思想：
大模型本身不能真的在你电脑上执行命令；我们给它注册一个「工具」(这里是 bash)，
它若决定调用工具，我们就本地执行，把 stdout/stderr 当作「工具返回值」再贴回对话里，
让模型继续推理。这样多轮往复，就是一个最小的「能改你仓库的 agent」。
"""
import os
import subprocess
from dataclasses import dataclass

# 可选：改善终端里中文输入/退格体验（仅 macOS 等环境有 readline 时生效）
try:
    import readline

    # #143 UTF-8 backspace fix for macOS libedit
    readline.parse_and_bind("set bind-tty-special-chars off")
    readline.parse_and_bind("set input-meta on")
    readline.parse_and_bind("set output-meta on")
    readline.parse_and_bind("set convert-meta off")
    readline.parse_and_bind("set enable-meta-keybindings on")
except ImportError:
    pass

from anthropic import Anthropic
from dotenv import load_dotenv

# 从项目根目录的 .env 读入环境变量（API Key、Base URL、模型名等）
load_dotenv(override=True)

# Anthropic 官方 Python SDK；通过 ANTHROPIC_BASE_URL 可指向兼容网关（如 MiniMax 的 Anthropic 兼容接口）
client = Anthropic(base_url=os.getenv("ANTHROPIC_BASE_URL"))
MODEL = os.environ["MODEL_ID"]

# system：每条请求都会带上的「系统提示」，约束模型行为与身份
SYSTEM = (
    f"You are a coding agent at {os.getcwd()}. "
    "Use bash to inspect and change the workspace. Act first, then report clearly."
)

# tools：告诉模型「你可以调用哪些函数、参数长什么样」。
# 模型返回的不会是 Python 函数调用，而是结构化的 tool_use 块（名称 + JSON 参数）。
TOOLS = [
    {
        "name": "bash",
        "description": "Run a shell command in the current workspace.",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string"}},
            "required": ["command"],
        },
    }
]


@dataclass
class LoopState:
    """
    一次「用户提问 → agent 多轮工具」过程中需要携带的最小状态。

    - messages: 对话历史，格式需符合 Messages API（user/assistant 交替，内容可为文本块或 tool 块）
    - turn_count: 统计本轮 agent 循环走了几轮（便于日志或限流）
    - transition_reason: 可选，标记上一轮为何继续（这里用于区分是否因工具结果而继续）
    """

    messages: list
    turn_count: int = 1
    transition_reason: str | None = None


def run_bash(command: str) -> str:
    """
    在「当前工作目录」下执行一条 shell 命令，返回字符串形式的输出。

    注意：shell=True 有注入风险；教学示例里用简单黑名单挡掉明显危险片段。
    生产环境应使用更严格的校验或白名单命令。
    """
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(item in command for item in dangerous):
        return "Error: Dangerous command blocked"
    try:
        result = subprocess.run(
            command,
            shell=True,
            cwd=os.getcwd(),
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.TimeoutExpired:
        return "Error: Timeout (120s)"
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"
    output = (result.stdout + result.stderr).strip()
    # 防止单条输出过大撑爆上下文
    return output[:50000] if output else "(no output)"


def extract_text(content) -> str:
    """
    从 assistant 消息的 content 里抽出人类可读的最终文本。

    API 返回的 content 往往是「块」的列表：text、tool_use、thinking 等；
    这里只拼接 type 为文本的部分，便于在 REPL 末尾打印给用户看。
    """
    if not isinstance(content, list):
        return ""
    texts = []
    for block in content:
        text = getattr(block, "text", None)
        if text:
            texts.append(text)
    return "\n".join(texts).strip()


def execute_tool_calls(response_content) -> list[dict]:
    """
    遍历模型本轮回复里的每个 content block，执行其中所有 tool_use（此处即 bash）。

    返回值：符合 API 要求的 tool_result 块列表，稍后作为一条 user 消息发回给模型。
    每个 tool_result 必须用对应的 tool_use_id 与之前的 tool_use 对齐。
    """
    results = []
    for block in response_content:
        if block.type != "tool_use":
            continue
        command = block.input["command"]
        print(f"\033[33m$ {command}\033[0m")
        output = run_bash(command)
        print(output[:200])
        results.append(
            {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output,
            }
        )
    return results


def run_one_turn(state: LoopState) -> bool:
    """
    执行「一轮」agent 逻辑：

    1) 把当前 state.messages 发给模型（含之前的用户话、助手话、工具结果）
    2) 把助手整段回复追加进历史
    3) 若 stop_reason 是 tool_use：本地执行工具，把 tool_result 再追加为一条 user 消息
    4) 返回 True 表示「还要继续问模型」，False 表示「本轮对话可结束」

    关于为什么 tool_result 放在 role=user 里：这是 Anthropic Messages API 的约定，
    「工具输出」由客户端以 user 角色提交，模型才能在下一轮把它当作已发生的事实来用。
    """
    response = client.messages.create(
        model=MODEL,
        system=SYSTEM,
        messages=state.messages,
        tools=TOOLS,
        max_tokens=8000,
    )
    # 原样保存助手消息（可能同时包含文本块 + 多个 tool_use 块）
    state.messages.append({"role": "assistant", "content": response.content})

    # stop_reason 不是 tool_use：模型选择直接结束（例如纯回答、或不再调用工具）
    if response.stop_reason != "tool_use":
        state.transition_reason = None
        return False

    results = execute_tool_calls(response.content)
    if not results:
        # 理论上少见：声明了 tool_use 却没有可执行结果，避免死循环直接停
        state.transition_reason = None
        return False

    # 把工具输出写回历史；下一轮 run_one_turn 会基于完整历史再次调用模型
    state.messages.append({"role": "user", "content": results})
    state.turn_count += 1
    state.transition_reason = "tool_result"
    return True


def agent_loop(state: LoopState) -> None:
    """反复调用 run_one_turn，直到模型不再请求工具为止。"""
    while run_one_turn(state):
        pass


if __name__ == "__main__":
    # history 在多次用户输入之间复用：同一终端会话里连续提问会带着上文
    history = []
    while True:
        try:
            query = input("\033[36ms01 >> \033[0m")
        except (EOFError, KeyboardInterrupt):
            break
        if query.strip().lower() in ("q", "exit", ""):
            break

        # 用户自然语言请求
        history.append({"role": "user", "content": query})

        # 针对本轮用户输入，跑完整个「模型 ↔ 工具」闭环
        state = LoopState(messages=history)
        agent_loop(state)

        # 循环结束后，history 最后一项通常是助手最后一次回复；从中抽文本打印
        final_text = extract_text(history[-1]["content"])
        if final_text:
            print(final_text)
        print()
