// server.js
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: function (origin, callback) {
    // 允许所有来源（小程序不需要检查 origin）
    callback(null, true);
  },
  credentials: true
}));
app.use(express.json());

const PORT = process.env.PORT || 3000; // 支持环境变量配置端口

// ========== 配置区域：请填入你的真实 API Key ==========
const DOU_BAO_API_KEY = '7139fcb3-744e-4cc1-90a9-98e165f83bf7'; // 从豆包官网获取
const DEEPSEEK_API_KEY = 'sk-3d6342305f2f434f8af2bc547e94b0c4'; // 从DeepSeek官网获取

// 豆包 API 配置（根据官方文档调整）
const DOU_BAO_API_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses'; // 示例URL，需替换
const DOU_BAO_MODEL = 'doubao-seed-1-6-251015'; // 示例模型名，需替换

// DeepSeek API 配置
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_MODEL = 'deepseek-reasoner'; // 或 deepseek-chat

// ========== 工具函数：构造系统提示词 ==========
function buildSystemPrompt(config) {
  const { topic, sideA_role, sideB_role, tone } = config;
  
  const toneDesc = tone === 'mild' ? '温和克制，有理有据，以理服人' : 
                   tone === 'strong' ? '激烈犀利，针锋相对，但不人身攻击，不涉及敏感内容' : 
                   tone === 'bickering' ? '斗嘴风格，互相调侃，用幽默和机智反驳对方，可以使用少量脏话（如"扯淡"、"放屁"等），可以进行轻微的人身攻击（如"你这种观点太幼稚了"、"你根本不了解情况"），但保持辩论的合理性，不能全是脏话' :
                   tone === 'aggressive' ? '暴躁风格，语气激烈，态度强硬，直接反驳，可以使用较多脏话，但必须使用多样化的脏词（如"扯淡"、"放屁"、"胡说八道"、"荒谬"、"无稽之谈"、"瞎说"、"胡扯"、"扯犊子"、"一派胡言"、"荒谬绝伦"等），避免重复使用相同的脏词，每轮发言中同一个脏词最多使用1-2次，要使用不同的脏词来增强表达力。可以进行轻微的人身攻击（如"你这种观点太幼稚了"、"你根本不了解情况"、"你这种想法很可笑"），但保持辩论的合理性，不能全是脏话，不能过度人身攻击' :
                   '理性客观，逻辑清晰，条理分明';
  
  const sideA = sideA_role || '支持该命题的一方';
  const sideB = sideB_role || '反对该命题的一方';
  
  return `你是一位专业的辩论系统，需要同时扮演两位辩手进行一场正式辩论。

【核心辩题】
${topic}

【角色身份与立场（必须严格遵守）】
- 辩手 A：${sideA}
  * 你的核心任务：始终站在"${sideA}"的立场，为这个立场辩护
  * 你的身份标签：支持方/正方
  * 你必须记住：无论进行多少轮辩论，你的立场都是"${sideA}"，绝对不能改变
  
- 辩手 B：${sideB}
  * 你的核心任务：始终站在"${sideB}"的立场，为这个立场辩护
  * 你的身份标签：反对方/反方
  * 你必须记住：无论进行多少轮辩论，你的立场都是"${sideB}"，绝对不能改变

【关键规则（必须严格遵守）】
1. 立场一致性：辩手 A 和 B 必须始终坚守各自立场，无论进行多少轮，立场都不能改变。这是最重要的规则。
2. 创新性要求：每次辩论必须从不同角度、使用不同的论据和案例，避免重复使用相同的观点。即使是同一个辩题，也要尝试从新的视角切入，使用不同的例子和数据。
3. 针对性回应：每一轮发言必须明确引用和回应对方上一轮的具体观点，不能自说自话。例如："对方刚才提到...，但我认为..."。
4. 发言结构：每轮发言应包含：
   - 开头（1-2句）：简要回应对方上一轮的核心论点
   - 主体（2-3个要点）：提出自己的新论据或深化已有论点
   - 结尾（1句）：总结本方的核心观点
5. 字数控制：每轮发言严格控制在 150-200 字之间，言简意赅，逻辑清晰。
6. 论证方式：可以使用数据、案例、类比、逻辑推理、反证法等支撑观点。
7. 语气风格：${toneDesc}
8. 脏词使用（仅适用于"斗嘴"和"暴躁"语气）：如果使用脏话，必须使用多样化的脏词，避免重复。每轮发言中同一个脏词最多使用1-2次，要尝试使用不同的脏词来表达相似的意思，增强表达的丰富性和冲击力。
9. 禁止事项：
   - 如果语气是"温和"或"普通"或"激烈"：禁止人身攻击、禁止使用脏话、禁止涉及政治敏感内容、禁止偏离辩题
   - 如果语气是"斗嘴"或"暴躁"：可以使用少量脏话和轻微人身攻击，但禁止过度人身攻击、禁止涉及政治敏感内容、禁止偏离辩题、禁止全是脏话没有实质内容

【输出格式要求】
请严格按照以下 JSON 格式输出，不要输出任何其他文字、解释或标记：
{
  "A": "辩手A的完整发言内容（150-200字，必须针对B上一轮的观点进行回应）",
  "B": "辩手B的完整发言内容（150-200字，必须针对A本轮的观点进行回应）"
}

【重要提醒】
- 辩手 A 和 B 是独立的两个角色，各自有明确的立场，不能混淆
- 输出时，A 的发言应该体现"${sideA}"的立场，B 的发言应该体现"${sideB}"的立场
- 如果这是第一轮，A 和 B 可以各自陈述初始观点；如果是后续轮次，必须引用对方上一轮的具体观点`;
}

// ========== 工具函数：构造用户提示词（包含历史对话）==========
function buildUserPrompt(currentRound, historyMessages) {
  // 生成一个随机种子，用于增加多样性
  const randomSeed = Math.floor(Math.random() * 1000);
  
  if (!historyMessages || historyMessages.length === 0) {
    // 第一轮：没有历史对话
    return `请生成第 ${currentRound} 轮的辩论发言。这是第一轮，辩手 A 和 B 各自陈述初始观点。

【重要要求】
1. 辩手 A 先发言，辩手 B 再发言
2. 请从独特的角度切入，使用不同的论据和案例，避免使用常见的、老生常谈的观点
3. 尝试从以下角度思考（但不限于）：
   - 经济学角度（成本效益、资源配置、市场机制）
   - 社会学角度（社会结构、群体行为、文化影响）
   - 心理学角度（个体动机、认知偏差、行为模式）
   - 历史学角度（历史案例、发展趋势、经验教训）
   - 哲学角度（价值判断、伦理考量、本质思考）
4. 使用具体、新颖的案例和数据，避免泛泛而谈`;
  }
  
  // 后续轮次：包含历史对话摘要
  const historySummary = historyMessages
    .map((msg, idx) => {
      const speaker = msg.speaker === 'A' ? '辩手A' : '辩手B';
      const round = Math.floor(idx / 2) + 1;
      return `第${round}轮 - ${speaker}：${msg.content.substring(0, 100)}...`;
    })
    .join('\n');
  
  return `请生成第 ${currentRound} 轮的辩论发言。

【历史对话摘要】
${historySummary}

【重要要求】
1. 辩手 A 必须针对辩手 B 上一轮（第 ${currentRound - 1} 轮）的观点进行回应和反驳
2. 辩手 B 必须针对辩手 A 本轮（第 ${currentRound} 轮）的观点进行回应和反驳
3. 必须引用对方的具体观点，不能自说自话
4. 【创新性要求】请从新的角度思考，使用不同的论据和案例，避免重复之前已经使用过的观点和例子
5. 尝试从不同的学科视角或实践案例来支撑自己的观点，让辩论更有深度和广度`;
}

// ========== 调用豆包 API ==========
async function callDouBao(systemPrompt, userPrompt, historyMessages = []) {
  try {
    // 豆包 API 使用 input 数组格式
    const input = [];
    
    // 添加系统提示词（如果有历史对话，系统提示词包含历史摘要）
    let fullSystemPrompt = systemPrompt;
    if (historyMessages && historyMessages.length > 0) {
      const historyText = historyMessages
        .map(msg => `${msg.speaker === 'A' ? '辩手A' : '辩手B'}：${msg.content}`)
        .join('\n');
      fullSystemPrompt = `${systemPrompt}\n\n【历史对话】\n${historyText}`;
    }
    
    // 将系统提示词和用户提示词合并作为用户消息
    const finalPrompt = `${fullSystemPrompt}\n\n${userPrompt}`;
    
    // 豆包 API 格式：input 是数组，每个元素是一个消息
    input.push({
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: finalPrompt
        }
      ]
    });
    
    const response = await fetch(DOU_BAO_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DOU_BAO_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DOU_BAO_MODEL,
        input: input
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('豆包 API 错误详情:', errorText);
      throw new Error(`豆包API错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    
    // 豆包 API 返回格式：output 数组，最后一个 message 类型包含 content
    let content;
    if (data.output && Array.isArray(data.output)) {
      // 找到最后一个 type 为 "message" 的输出
      const messageOutput = data.output.find(item => item.type === 'message');
      if (messageOutput && messageOutput.content && Array.isArray(messageOutput.content)) {
        // 找到 type 为 "output_text" 的内容
        const textContent = messageOutput.content.find(item => item.type === 'output_text');
        if (textContent && textContent.text) {
          content = textContent.text.trim();
        }
      }
    }
    
    // 如果没找到，尝试其他格式（兼容性处理）
    if (!content) {
      if (data.choices && data.choices[0] && data.choices[0].message) {
        content = data.choices[0].message.content.trim();
      } else if (data.text) {
        content = data.text.trim();
      } else if (data.result) {
        content = data.result.trim();
      } else {
        console.warn('豆包返回格式未知，原始数据:', JSON.stringify(data, null, 2));
        content = JSON.stringify(data);
      }
    }
    
    // 尝试解析 JSON
    try {
      return JSON.parse(content);
    } catch (e) {
      console.warn('豆包返回的不是标准JSON，尝试提取内容...');
      return {
        A: content.split('辩手A')[1]?.split('辩手B')[0]?.trim() || content.substring(0, content.length / 2),
        B: content.split('辩手B')[1]?.trim() || content.substring(content.length / 2)
      };
    }
  } catch (error) {
    console.error('调用豆包API失败:', error);
    throw error;
  }
}

// ========== 调用 DeepSeek API ==========
async function callDeepSeek(systemPrompt, userPrompt, historyMessages = []) {
  try {
    // 构建消息历史
    const messages = [
      { role: 'system', content: systemPrompt }
    ];
    
    // 如果有历史对话，添加到消息中
    if (historyMessages && historyMessages.length > 0) {
      historyMessages.forEach(msg => {
        const role = msg.speaker === 'A' ? 'user' : 'assistant';
        messages.push({
          role: role,
          content: `${msg.speaker === 'A' ? '辩手A' : '辩手B'}：${msg.content}`
        });
      });
    }
    
    messages.push({ role: 'user', content: userPrompt });
    
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: messages,
        temperature: 0.9, // 提高温度值，增加输出的多样性和创造性（范围 0-1，0.9 表示更有创造性）
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DeepSeek API错误: ${response.status} - ${errorText}`);
    }

    const data = await response.json();
    const content = data.choices[0].message.content.trim();
    
    try {
      return JSON.parse(content);
    } catch (e) {
      console.warn('DeepSeek返回的不是标准JSON，尝试提取内容...');
      return {
        A: content.split('辩手A')[1]?.split('辩手B')[0]?.trim() || content.substring(0, content.length / 2),
        B: content.split('辩手B')[1]?.trim() || content.substring(content.length / 2)
      };
    }
  } catch (error) {
    console.error('调用DeepSeek API失败:', error);
    throw error;
  }
}
// ========== 中间件：日志 ==========
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// ========== 主接口：生成下一轮辩论 ==========
app.post('/api/debate/next-round', async (req, res) => {
  try {
    const { config, currentRound, provider = 'deepseek', history = [] } = req.body || {};
    
    if (!config || !config.topic) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数：config.topic'
      });
    }

    const round = currentRound || 1;
    const systemPrompt = buildSystemPrompt(config);
    const userPrompt = buildUserPrompt(round, history);
    
    // 历史消息格式转换
    const historyMessages = Array.isArray(history) ? history : [];

    let result;
    
    if (provider === 'deepseek') {
      console.log(`使用 DeepSeek 生成第 ${round} 轮，历史消息数：${historyMessages.length}`);
      result = await callDeepSeek(systemPrompt, userPrompt, historyMessages);
    } else {
      console.log(`使用豆包生成第 ${round} 轮，历史消息数：${historyMessages.length}`);
      result = await callDouBao(systemPrompt, userPrompt, historyMessages);
    }

    res.json({
      ok: true,
      round,
      A: result.A || '（生成失败）',
      B: result.B || '（生成失败）'
    });
   } catch (error) {
    console.error('生成辩论失败:', error);
    
    // 根据错误类型返回不同的错误信息
    let errorMessage = '生成失败，请稍后重试';
    let errorCode = 'server_error';
    
    if (error.message.includes('API错误')) {
      if (error.message.includes('401') || error.message.includes('Unauthorized')) {
        errorMessage = 'API Key 无效，请检查配置';
        errorCode = 'api_key_error';
      } else if (error.message.includes('402') || error.message.includes('Insufficient Balance')) {
        errorMessage = '账户余额不足，请充值后再试';
        errorCode = 'insufficient_balance';
      } else if (error.message.includes('404') || error.message.includes('Not Found')) {
        errorMessage = 'API 地址或模型不存在，请检查配置';
        errorCode = 'api_not_found';
      } else if (error.message.includes('429') || error.message.includes('rate limit')) {
        errorMessage = '请求过于频繁，请稍后再试';
        errorCode = 'rate_limit';
      } else {
        errorMessage = 'AI 服务调用失败，请稍后重试';
        errorCode = 'api_error';
      }
    } else if (error.message.includes('网络') || error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = '网络连接失败，请检查网络后重试';
      errorCode = 'network_error';
    }
    
    res.status(500).json({
      ok: false,
      error: errorCode,
      message: errorMessage
    });
  }
});

// ========== 启动服务器 ==========
app.listen(PORT, () => {
  console.log(`Debate server listening on http://localhost:${PORT}`);
  console.log('请确保已配置 DOU_BAO_API_KEY 和 DEEPSEEK_API_KEY');
});