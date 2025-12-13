// ========== 微信支付配置 ==========
const WECHAT_PAY_CONFIG = {
  appId: '你的小程序AppID',
  mchId: '你的商户号',
  apiKey: '你的API密钥',
  notifyUrl: 'http://你的服务器IP:3000/api/member/payment-callback' // 支付回调地址
};

// 用户数据存储（实际应该用数据库，这里先用内存）
const users = new Map(); // key: openid, value: userData
const debateRecords = new Map(); // key: openid, value: [debateDates...]
// 辩论请求锁，防止并发请求导致重复消耗次数
const debateLocks = new Map(); // key: openid, value: boolean

// 会员相关配置
const MEMBER_CONFIG = {
  NORMAL: {
    name: '普通会员',
    price: 6, // 元/月
    maxDebates: 300,
    duration: 30 * 24 * 60 * 60 * 1000 // 30天（毫秒）
  },
  SUPER: {
    name: '超级会员',
    price: 30, // 元/月
    maxDebates: 1000,
    duration: 30 * 24 * 60 * 60 * 1000 // 30天（毫秒）
  },
  FREE: {
    name: '普通用户',
    maxDebatesPerDay: 5
  }
};

// server.js
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// 创建上传目录
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// 配置 multer 文件上传
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'payment-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 限制 5MB
});

const app = express();
app.use(cors({
  origin: function (origin, callback) {
    // 允许所有来源（小程序不需要检查 origin）
    callback(null, true);
  },
  credentials: true
}));
app.use(express.json());

// ========== MySQL 数据库配置 ==========
const dbConfig = {
  host: 'localhost',
  user: 'debate_user', // 使用专用用户
  password: '!MZlwsol030616',
  database: 'cyber_debate_db',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  // 连接超时时间（毫秒）
  connectTimeout: 10000
};

// 创建连接池
const pool = mysql.createPool(dbConfig);

// 数据库连接测试和自动重连函数
async function testDatabaseConnection(retryCount = 0, maxRetries = 5) {
  try {
    const connection = await pool.getConnection();
    console.log('✅ 数据库连接成功');
    console.log('数据库配置:', {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database
    });
    connection.release();
    return true;
  } catch (err) {
    console.error(`❌ 数据库连接失败 (尝试 ${retryCount + 1}/${maxRetries}):`);
    console.error('错误代码:', err.code);
    console.error('错误信息:', err.message);
    
    if (retryCount < maxRetries - 1) {
      const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // 指数退避，最多10秒
      console.log(`⏳ ${delay/1000}秒后自动重试...`);
      setTimeout(() => {
        testDatabaseConnection(retryCount + 1, maxRetries);
      }, delay);
    } else {
      console.error('❌ 数据库连接失败，已达到最大重试次数');
      console.error('当前配置:', {
        host: dbConfig.host,
        user: dbConfig.user,
        database: dbConfig.database,
        hasPassword: !!dbConfig.password
      });
      console.error('请检查：');
      console.error('1. MySQL 服务是否运行: sudo systemctl status mysql');
      console.error('2. 数据库用户是否存在: SELECT user FROM mysql.user WHERE user = "debate_user";');
      console.error('3. 密码是否正确');
      console.error('4. 数据库是否存在: SHOW DATABASES LIKE "cyber_debate_db";');
    }
    return false;
  }
}

// 初始连接测试
testDatabaseConnection();

// 监听连接错误，自动重连
pool.on('error', (err) => {
  console.error('数据库连接池错误:', err);
  if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNREFUSED') {
    console.log('🔄 检测到连接断开，尝试重新连接...');
    setTimeout(() => {
      testDatabaseConnection();
    }, 2000);
  }
});

// 定期检查连接（每5分钟）
setInterval(async () => {
  try {
    const connection = await pool.getConnection();
    connection.ping();
    connection.release();
    console.log('💓 数据库连接正常');
  } catch (err) {
    console.error('⚠️ 数据库连接检查失败:', err.message);
    console.log('🔄 尝试重新连接...');
    testDatabaseConnection();
  }
}, 5 * 60 * 1000); // 5分钟

// ========== 微信配置（需要替换成你的小程序 AppID 和 AppSecret） ==========
const WECHAT_CONFIG = {
  appId: 'wxbf9cb430eb84f210', // 在微信小程序后台获取
  appSecret: '11360799715b1a256fd7038ad7eb71cb' // 在微信小程序后台获取
};

// ========== 用户登录/注册接口 ==========
app.post('/api/user/login', async (req, res) => {
  try {
    const { code, openid } = req.body;
    
    let finalOpenid = openid;

    // 如果有 code，先通过 code 换取 openid
    if (code) {
      try {
        const openidResult = await exchangeCodeForOpenid(code);
        if (openidResult.openid) {
          finalOpenid = openidResult.openid;
        } else {
          // 如果换取失败，返回错误
          return res.status(400).json({
            ok: false,
            error: '微信登录失败，请检查 AppID 和 AppSecret 配置'
          });
        }
      } catch (error) {
        console.error('换取 openid 失败:', error);
        return res.status(400).json({
          ok: false,
          error: '微信登录失败：' + (error?.message || error?.toString() || '未知错误')
        });
      }
    }

    if (!finalOpenid) {
      return res.status(400).json({
        ok: false,
        error: '缺少 openid 或 code'
      });
    }

    // 如果用户不存在，先尝试从数据库加载
    if (!users.has(finalOpenid)) {
      try {
        const dbUser = await loadUserFromDB(finalOpenid);
        if (dbUser) {
          // 数据库中存在，加载到内存
          users.set(finalOpenid, dbUser);
        } else {
          // 数据库中不存在，创建新用户
          const newUser = {
            openid: finalOpenid,
            memberType: 'FREE', // FREE, NORMAL, SUPER
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0, // 广告奖励的辩论次数
            createdAt: Date.now()
          };
          users.set(finalOpenid, newUser);
          // 保存到数据库（等待保存完成，确保数据持久化）
          try {
            await saveUserToDB(newUser);
            console.log(`✅ 新用户已保存到数据库: ${finalOpenid}`);
          } catch (err) {
            console.error('保存新用户到数据库失败:', err);
            // 即使保存失败，也继续返回用户信息（使用内存存储）
            // 但记录错误，方便后续排查
          }
        }
      } catch (error) {
        console.error('加载用户失败，使用内存存储:', error);
        // 如果数据库操作失败，仍然使用内存存储
        users.set(finalOpenid, {
          openid: finalOpenid,
          memberType: 'FREE',
          memberExpireAt: null,
          debatesUsed: 0,
          memberStartAt: null,
          adRewardDebates: 0,
          createdAt: Date.now()
        });
      }
    }

    const user = users.get(finalOpenid);
    
    res.json({
      ok: true,
      user: {
        openid: user.openid,
        memberType: user.memberType,
        memberExpireAt: user.memberExpireAt,
        debatesUsed: user.debatesUsed,
        maxDebates: getMaxDebates(user),
        todayDebates: getTodayDebates(finalOpenid),
        adRewardDebates: user.adRewardDebates || 0
      }
    });
  } catch (error) {
    console.error('用户登录失败:', error);
    res.status(500).json({
      ok: false,
      error: '登录失败'
    });
  }
});

// ========== 工具函数：使用 code 换取 openid ==========
async function exchangeCodeForOpenid(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${WECHAT_CONFIG.appId}&secret=${WECHAT_CONFIG.appSecret}&js_code=${code}&grant_type=authorization_code`;
  
  try {
    const response = await fetch(url);
    const data = await response.json();
    
    if (data.errcode) {
      throw new Error(`微信接口错误: ${data.errcode} - ${data.errmsg}`);
    }
    
    return {
      openid: data.openid,
      session_key: data.session_key
    };
  } catch (error) {
    console.error('换取 openid 失败:', error);
    throw error;
  }
}

// ========== 获取用户信息接口 ==========
app.get('/api/user/info', async (req, res) => {
  try {
    const { openid } = req.query;
    
    if (!openid) {
      return res.status(400).json({
        ok: false,
        error: '缺少 openid'
      });
    }

    let user = users.get(openid);
    if (!user) {
      // 尝试从数据库加载
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          return res.status(404).json({
            ok: false,
            error: '用户不存在'
          });
        }
      } catch (error) {
        console.error('从数据库加载用户失败:', error);
        return res.status(404).json({
          ok: false,
          error: '用户不存在'
        });
      }
    }

    res.json({
      ok: true,
      user: {
        openid: user.openid,
        memberType: user.memberType,
        memberExpireAt: user.memberExpireAt,
        debatesUsed: user.debatesUsed,
        maxDebates: getMaxDebates(user),
        todayDebates: getTodayDebates(openid),
        adRewardDebates: user.adRewardDebates || 0
      }
    });
  } catch (error) {
    console.error('获取用户信息失败:', error);
    res.status(500).json({
      ok: false,
      error: '获取用户信息失败'
    });
  }
});

// ========== 广告奖励接口 ==========
app.post('/api/user/reward-ad', async (req, res) => {
  try {
    const { openid, rewardType = 'debate_count', rewardAmount = 1 } = req.body;
    
    if (!openid) {
      return res.status(400).json({
        ok: false,
        error: '缺少 openid'
      });
    }

    // 确保用户存在
    let user = users.get(openid);
    if (!user) {
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          const newUser = {
            openid: openid,
            memberType: 'FREE',
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0,
            createdAt: Date.now()
          };
          users.set(openid, newUser);
          user = newUser;
          // 保存到数据库（等待保存完成，确保数据持久化）
          try {
            await saveUserToDB(newUser);
            console.log(`✅ 广告奖励：新用户已保存到数据库: ${openid}`);
          } catch (err) {
            console.error('保存新用户到数据库失败:', err);
            // 即使保存失败，也继续处理（使用内存存储）
          }
        }
      } catch (error) {
        console.error('加载用户失败，使用内存存储:', error);
        const newUser = {
          openid: openid,
          memberType: 'FREE',
          memberExpireAt: null,
          debatesUsed: 0,
          memberStartAt: null,
          adRewardDebates: 0,
          createdAt: Date.now()
        };
        users.set(openid, newUser);
        user = newUser;
      }
    }

    // 初始化 adRewardDebates 字段（兼容旧数据）
    if (user.adRewardDebates === undefined) {
      user.adRewardDebates = 0;
    }

    // 给予奖励
    if (rewardType === 'debate_count') {
      user.adRewardDebates = (user.adRewardDebates || 0) + rewardAmount;
      console.log(`用户 ${openid} 通过观看广告获得 ${rewardAmount} 次免费辩论，当前广告奖励次数: ${user.adRewardDebates}`);
      // 同步到数据库
      saveUserToDB(user).catch(err => {
        console.error('更新用户到数据库失败:', err);
      });
    }

    res.json({
      ok: true,
      message: '奖励已发放',
      rewardType: rewardType,
      rewardAmount: rewardAmount,
      adRewardDebates: user.adRewardDebates
    });
  } catch (error) {
    console.error('发放广告奖励失败:', error);
    res.status(500).json({
      ok: false,
      error: '发放奖励失败'
    });
  }
});

// ========== 工具函数：获取最大辩论次数 ==========
function getMaxDebates(user) {
  if (user.memberType === 'NORMAL') {
    return MEMBER_CONFIG.NORMAL.maxDebates;
  } else if (user.memberType === 'SUPER') {
    return MEMBER_CONFIG.SUPER.maxDebates;
  }
  return MEMBER_CONFIG.FREE.maxDebatesPerDay;
}

// ========== 工具函数：获取今日已使用次数 ==========
function getTodayDebates(openid) {
  const today = new Date().toDateString();
  const records = debateRecords.get(openid) || [];
  const memoryCount = records.filter(date => new Date(date).toDateString() === today).length;
  
  // 如果内存中没有记录，尝试从数据库加载（异步，不阻塞）
  if (records.length === 0) {
    loadDebateRecordsFromDB(openid).then(dbRecords => {
      if (dbRecords.length > 0) {
        debateRecords.set(openid, dbRecords);
      }
    }).catch(err => {
      console.error('从数据库加载辩论记录失败:', err);
    });
  }
  
  return memoryCount;
}

// ========== 工具函数：检查会员是否有效 ==========
function isMemberValid(user) {
  if (user.memberType === 'FREE') {
    return false;
  }
  
  if (!user.memberExpireAt) {
    return false;
  }
  
  return Date.now() < user.memberExpireAt;
}

// ========== 工具函数：检查是否需要会员 ==========
function requiresMember(config) {
  // 检查轮数
  const highRounds = config.rounds === 12 || config.rounds === 15;
  
  // 检查语气
  const aggressiveTone = config.tone === 'aggressive';
  
  return highRounds || aggressiveTone;
}

// ========== 工具函数：检查是否可以辩论 ==========
function canDebate(user, config) {
  // 检查是否需要会员
  if (requiresMember(config)) {
    if (!isMemberValid(user)) {
      return {
        can: false,
        reason: '选择12/15轮或暴躁语气需要会员'
      };
    }
  }

  // 检查次数限制
  if (user.memberType === 'FREE') {
    const todayDebates = getTodayDebates(user.openid);
    const adRewardDebates = user.adRewardDebates || 0;
    // 免费用户：总可用次数 = 每日限制 + 广告奖励次数
    const totalAvailable = MEMBER_CONFIG.FREE.maxDebatesPerDay + adRewardDebates;
    if (todayDebates >= totalAvailable) {
      return {
        can: false,
        reason: '今日免费次数已用完，请购买会员或观看广告获得更多次数'
      };
    }
  } else if (isMemberValid(user)) {
    const maxDebates = getMaxDebates(user);
    if (user.debatesUsed >= maxDebates) {
      return {
        can: false,
        reason: '会员次数已用完，请续费'
      };
    }
  } else {
    // 会员已过期，降级为普通用户
    const todayDebates = getTodayDebates(user.openid);
    const adRewardDebates = user.adRewardDebates || 0;
    // 总可用次数 = 每日限制 + 广告奖励次数
    const totalAvailable = MEMBER_CONFIG.FREE.maxDebatesPerDay + adRewardDebates;
    if (todayDebates >= totalAvailable) {
      return {
        can: false,
        reason: '会员已过期，今日免费次数已用完，请购买会员或观看广告获得更多次数'
      };
    }
  }

  return {
    can: true
  };
}

// ========== 工具函数：记录辩论 ==========
function recordDebate(openid) {
  const debateTime = Date.now();
  const records = debateRecords.get(openid) || [];
  records.push(debateTime);
  debateRecords.set(openid, records);
  
  // 保存到数据库（异步，不阻塞）
  saveDebateRecordToDB(openid, debateTime).catch(err => {
    console.error('保存辩论记录到数据库失败:', err);
  });

  // 更新用户使用次数
  const user = users.get(openid);
  if (user) {
    if (isMemberValid(user)) {
      // 会员用户：增加已用次数
      user.debatesUsed += 1;
      // 同步到数据库（异步，不阻塞）
      saveUserToDB(user).catch(err => {
        console.error('更新用户到数据库失败:', err);
      });
    } else if (user.memberType === 'FREE') {
      // 免费用户：优先消耗广告奖励次数
      if (user.adRewardDebates && user.adRewardDebates > 0) {
        user.adRewardDebates -= 1;
        console.log(`用户 ${openid} 使用广告奖励次数，剩余: ${user.adRewardDebates}`);
        // 同步到数据库（异步，不阻塞）
        saveUserToDB(user).catch(err => {
          console.error('更新用户到数据库失败:', err);
        });
      }
      // 如果没有广告奖励次数，则消耗每日免费次数
      // 注意：每日免费次数通过 debateRecords 记录，getTodayDebates 会从 debateRecords 计算
      // 所以即使没有广告奖励次数，上面的 debateRecords.set 已经记录了本次使用
    }
  } else {
    // 用户不在内存中（理论上不应该发生，因为在调用 recordDebate 之前已经检查了用户是否存在）
    // 但为了安全，记录警告日志
    console.warn(`⚠️ recordDebate: 用户 ${openid} 不在内存中，但已记录到 debateRecords`);
  }
}

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

// ========== 微信支付工具函数 ==========
const crypto = require('crypto');

// 生成随机字符串
function generateNonceStr() {
  return Math.random().toString(36).substr(2, 15);
}

// 生成签名
function generateSign(params, apiKey) {
  const sortedKeys = Object.keys(params).sort();
  const stringA = sortedKeys
    .filter(key => params[key] && key !== 'sign')
    .map(key => `${key}=${params[key]}`)
    .join('&');
  const stringSignTemp = stringA + '&key=' + apiKey;
  return crypto.createHash('md5').update(stringSignTemp).digest('hex').toUpperCase();
}

// 生成微信支付参数
function generatePaymentParams(orderId, totalFee, openid) {
  const params = {
    appid: WECHAT_PAY_CONFIG.appId,
    mch_id: WECHAT_PAY_CONFIG.mchId,
    nonce_str: generateNonceStr(),
    body: '赛博斗蛐蛐会员',
    out_trade_no: orderId,
    total_fee: totalFee, // 单位：分
    spbill_create_ip: '127.0.0.1',
    notify_url: WECHAT_PAY_CONFIG.notifyUrl,
    trade_type: 'JSAPI',
    openid: openid
  };

  params.sign = generateSign(params, WECHAT_PAY_CONFIG.apiKey);

  return params;
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

// ========== 健康检查接口 ==========
app.get('/', (req, res) => {
  res.json({
    ok: true,
    message: '赛博斗蛐蛐 API 服务运行正常',
    timestamp: new Date().toISOString()
  });
});

// ========== 生成会员购买订单接口 ==========
app.post('/api/member/create-order', async (req, res) => {
  try {
    const { openid, memberType } = req.body;

    if (!openid) {
      return res.status(400).json({
        ok: false,
        error: '请先登录'
      });
    }

    if (!memberType || !['NORMAL', 'SUPER'].includes(memberType)) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    // 获取会员配置
    const memberConfig = MEMBER_CONFIG[memberType];
    if (!memberConfig) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    // 生成订单号
    const orderId = `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // 保存订单信息（实际应该存数据库，这里先用内存）
    if (!global.orders) {
      global.orders = new Map();
    }

    global.orders.set(orderId, {
      orderId,
      openid,
      memberType,
      price: memberConfig.price,
      status: 'PENDING', // PENDING, PAID, EXPIRED
      createdAt: Date.now()
    });

        // 生成微信支付参数
    const totalFee = Math.round(memberConfig.price * 100); // 转换为分
    const paymentParams = generatePaymentParams(orderId, totalFee, openid);

    // 调用微信支付统一下单接口
    try {
      const paymentResult = await callWeChatPay(paymentParams);
      
      if (paymentResult.return_code === 'SUCCESS' && paymentResult.result_code === 'SUCCESS') {
        // 生成小程序支付参数
        const payParams = {
          timeStamp: Math.floor(Date.now() / 1000).toString(),
          nonceStr: paymentResult.nonce_str,
          package: `prepay_id=${paymentResult.prepay_id}`,
          signType: 'MD5'
        };
        
        payParams.paySign = generateSign({
          appId: WECHAT_PAY_CONFIG.appId,
          timeStamp: payParams.timeStamp,
          nonceStr: payParams.nonceStr,
          package: payParams.package,
          signType: payParams.signType
        }, WECHAT_PAY_CONFIG.apiKey);

        res.json({
          ok: true,
          order: {
            orderId,
            memberType,
            memberName: memberConfig.name,
            price: memberConfig.price,
            maxDebates: memberConfig.maxDebates
          },
          payment: payParams
        });
      } else {
        throw new Error(paymentResult.return_msg || '支付参数生成失败');
      }
    } catch (error) {
      console.error('生成支付参数失败:', error);
      res.json({
        ok: false,
        error: '生成支付参数失败：' + (error?.message || error?.toString() || '未知错误')
      });
    }
  } catch (error) {
    console.error('创建订单失败:', error);
    res.status(500).json({
      ok: false,
      error: '创建订单失败'
    });
  }
});

// ========== 支付回调接口（微信支付成功后会调用） ==========
app.post('/api/member/payment-callback', (req, res) => {
  const xml2js = require('xml2js');
  
  // 解析微信支付回调 XML
  let xmlData = '';
  req.on('data', chunk => {
    xmlData += chunk.toString();
  });
  
  req.on('end', async () => {
    try {
      const parser = new xml2js.Parser({ explicitArray: false });
      const result = await parser.parseStringPromise(xmlData);
      const notifyData = result.xml;

      // 验证签名
      const sign = notifyData.sign;
      delete notifyData.sign;
      const calculatedSign = generateSign(notifyData, WECHAT_PAY_CONFIG.apiKey);
      
      if (sign !== calculatedSign) {
        console.error('签名验证失败');
        res.send('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[签名失败]]></return_msg></xml>');
        return;
      }

      // 验证支付结果
      if (notifyData.return_code !== 'SUCCESS' || notifyData.result_code !== 'SUCCESS') {
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }

      const orderId = notifyData.out_trade_no;
      const transactionId = notifyData.transaction_id;

      // 获取订单信息
      if (!global.orders || !global.orders.has(orderId)) {
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }

      const order = global.orders.get(orderId);

      // 如果订单已处理，直接返回成功
      if (order.status === 'PAID') {
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }

      // 更新订单状态
      order.status = 'PAID';
      order.transactionId = transactionId;
      order.paidAt = Date.now();

      // 更新用户会员信息
      let user = users.get(order.openid);
      if (!user) {
        try {
          const dbUser = await loadUserFromDB(order.openid);
          if (dbUser) {
            users.set(order.openid, dbUser);
            user = dbUser;
          } else {
            // 如果用户不存在，自动创建用户（异常情况处理）
            console.warn(`⚠️ 支付回调：用户 ${order.openid} 不存在，自动创建用户`);
            const newUser = {
              openid: order.openid,
              memberType: 'FREE',
              memberExpireAt: null,
              debatesUsed: 0,
              memberStartAt: null,
              adRewardDebates: 0,
              createdAt: Date.now()
            };
            users.set(order.openid, newUser);
            user = newUser;
            // 保存到数据库（等待保存完成，确保数据持久化）
            try {
              await saveUserToDB(newUser);
              console.log(`✅ 支付回调：新用户已保存到数据库: ${order.openid}`);
            } catch (err) {
              console.error('保存新用户到数据库失败:', err);
              // 即使保存失败，也继续处理（使用内存存储）
            }
          }
        } catch (error) {
          console.error('加载用户失败，使用内存存储:', error);
          const newUser = {
            openid: order.openid,
            memberType: 'FREE',
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0,
            createdAt: Date.now()
          };
          users.set(order.openid, newUser);
          user = newUser;
        }
      }

      const memberConfig = MEMBER_CONFIG[order.memberType];
      if (!memberConfig) {
        console.error(`❌ 支付回调失败：无效的会员类型: ${order.memberType}`);
        // 即使会员类型无效，也要返回成功给微信，避免重复回调
        res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
        return;
      }
      
      // 确保 adRewardDebates 字段存在（激活会员不影响广告奖励次数）
      if (user.adRewardDebates === undefined) {
        user.adRewardDebates = 0;
      }

      // 激活会员（使用与 approveOrder 相同的逻辑）
      const now = Date.now();
      const currentExpireAt = user.memberExpireAt;
      const isCurrentValid = currentExpireAt && now < currentExpireAt;

      // 规则2：相同会员类型，不叠加时间，只重置次数
      if (user.memberType === order.memberType && isCurrentValid) {
        user.debatesUsed = 0;
        console.log(`支付回调：会员次数已重置: ${order.openid}, 类型: ${order.memberType}`);
      }
      // 规则3：不同会员类型，升级（重置时间）
      else if (user.memberType !== order.memberType) {
        const oldMemberType = user.memberType;
        user.memberType = order.memberType;
        user.memberStartAt = now;
        user.memberExpireAt = now + memberConfig.duration;
        user.debatesUsed = 0;
        console.log(`支付回调：会员已升级: ${order.openid}, 从 ${oldMemberType} 升级到 ${order.memberType}`);
      }
      // 规则4：会员已过期，重新激活
      else {
        user.memberType = order.memberType;
        user.memberStartAt = now;
        user.memberExpireAt = now + memberConfig.duration;
        user.debatesUsed = 0;
        console.log(`支付回调：会员已重新激活: ${order.openid}, 类型: ${order.memberType}`);
      }

      // 同步到数据库
      await saveUserToDB(user);

      // 返回成功
      res.send('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[OK]]></return_msg></xml>');
    } catch (error) {
      console.error('处理支付回调失败:', error);
      res.send('<xml><return_code><![CDATA[FAIL]]></return_code><return_msg><![CDATA[处理失败]]></return_msg></xml>');
    }
  });
});

// ========== 手动激活会员接口（临时使用，支付配置好之前可以手动激活） ==========
app.post('/api/member/activate', async (req, res) => {
  try {
    const { openid, memberType } = req.body;

    if (!openid || !memberType) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数'
      });
    }

    if (!['NORMAL', 'SUPER'].includes(memberType)) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    let user = users.get(openid);
    if (!user) {
      // 尝试从数据库加载
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          return res.status(404).json({
            ok: false,
            error: '用户不存在'
          });
        }
      } catch (error) {
        console.error('从数据库加载用户失败:', error);
        return res.status(404).json({
          ok: false,
          error: '用户不存在'
        });
      }
    }

    const memberConfig = MEMBER_CONFIG[memberType];
    
    // 确保 adRewardDebates 字段存在（激活会员不影响广告奖励次数）
    if (user.adRewardDebates === undefined) {
      user.adRewardDebates = 0;
    }
    
    // 更新会员信息
    user.memberType = memberType;
    user.memberStartAt = Date.now();
    user.memberExpireAt = Date.now() + memberConfig.duration;
    user.debatesUsed = 0;

    // 同步到数据库
    await saveUserToDB(user);

    res.json({
      ok: true,
      message: '会员已激活',
      user: {
        openid: user.openid,
        memberType: user.memberType,
        memberExpireAt: user.memberExpireAt,
        maxDebates: memberConfig.maxDebates
      }
    });
  } catch (error) {
    console.error('激活会员失败:', error);
    res.status(500).json({
      ok: false,
      error: '激活会员失败'
    });
  }
});

// ========== 激活码数据库操作函数 ==========

// 检查激活码是否存在且未使用
async function checkActivationCode(code) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM activation_codes WHERE code = ?',
      [code]
    );
    
    if (rows.length === 0) {
      return { exists: false, codeInfo: null };
    }
    
    return { exists: true, codeInfo: rows[0] };
  } catch (error) {
    console.error('查询激活码失败:', error);
    throw error;
  }
}

// 标记激活码为已使用
async function markCodeAsUsed(code, openid) {
  try {
    const [result] = await pool.execute(
      'UPDATE activation_codes SET used = 1, used_by = ?, used_at = ? WHERE code = ?',
      [openid, Date.now(), code]
    );
    
    // 检查是否真的更新了行
    if (result.affectedRows === 0) {
      console.warn(`警告：激活码 ${code} 更新失败，可能不存在或已被使用`);
      throw new Error(`激活码 ${code} 更新失败`);
    }
    
    console.log(`✅ 激活码 ${code} 已标记为已使用，使用者: ${openid}，影响行数: ${result.affectedRows}`);
    return true;
  } catch (error) {
    console.error('❌ 标记激活码失败:', error);
    throw error;
  }
}

// 创建新激活码（管理员功能）
async function createActivationCode(code, memberType, expiresAt = null) {
  try {
    await pool.execute(
      'INSERT INTO activation_codes (code, member_type, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [code, memberType, Date.now(), expiresAt]
    );
    console.log(`激活码 ${code} 创建成功`);
    return true;
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      console.error('激活码已存在:', code);
      return false;
    }
    console.error('创建激活码失败:', error);
    throw error;
  }
}

// ========== 用户数据库操作函数 ==========

// 保存或更新用户到数据库
async function saveUserToDB(user) {
  try {
    const now = Date.now();
    await pool.execute(
      `INSERT INTO users (openid, member_type, member_expire_at, debates_used, member_start_at, ad_reward_debates, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
       member_type = VALUES(member_type),
       member_expire_at = VALUES(member_expire_at),
       debates_used = VALUES(debates_used),
       member_start_at = VALUES(member_start_at),
       ad_reward_debates = VALUES(ad_reward_debates),
       updated_at = VALUES(updated_at)`,
      [
        user.openid,
        user.memberType,
        user.memberExpireAt,
        user.debatesUsed,
        user.memberStartAt,
        user.adRewardDebates || 0,
        user.createdAt || now,
        now
      ]
    );
    return true;
  } catch (error) {
    console.error('保存用户到数据库失败:', error);
    // 如果表不存在，不抛出错误，允许继续运行
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.warn('⚠️ 用户表不存在，将使用内存存储');
      return false;
    }
    throw error;
  }
}

// 从数据库加载用户
async function loadUserFromDB(openid) {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM users WHERE openid = ?',
      [openid]
    );
    
    if (rows.length === 0) {
      return null;
    }
    
    const row = rows[0];
    return {
      openid: row.openid,
      memberType: row.member_type,
      memberExpireAt: row.member_expire_at,
      debatesUsed: row.debates_used,
      memberStartAt: row.member_start_at,
      adRewardDebates: row.ad_reward_debates || 0,
      createdAt: row.created_at
    };
  } catch (error) {
    console.error('从数据库加载用户失败:', error);
    // 如果表不存在，返回 null
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
}

// 从数据库加载所有用户到内存（启动时使用）
async function loadAllUsersFromDB() {
  try {
    const [rows] = await pool.execute('SELECT * FROM users');
    
    rows.forEach(row => {
      users.set(row.openid, {
        openid: row.openid,
        memberType: row.member_type,
        memberExpireAt: row.member_expire_at,
        debatesUsed: row.debates_used,
        memberStartAt: row.member_start_at,
        adRewardDebates: row.ad_reward_debates || 0,
        createdAt: row.created_at
      });
    });
    
    console.log(`✅ 从数据库加载了 ${rows.length} 个用户到内存`);
    return rows.length;
  } catch (error) {
    console.error('从数据库加载所有用户失败:', error);
    // 如果表不存在或连接失败，不抛出错误，允许继续运行（使用内存存储）
    if (error.code === 'ER_NO_SUCH_TABLE' || error.code === 'ECONNREFUSED' || error.code === 'PROTOCOL_CONNECTION_LOST') {
      console.warn('⚠️ 数据库连接失败或表不存在，将使用内存存储');
      return 0;
    }
    // 其他错误也不抛出，确保服务器能启动
    console.warn('⚠️ 数据库加载失败，将使用内存存储:', error.message);
    return 0;
  }
}

// 保存辩论记录到数据库
async function saveDebateRecordToDB(openid, debateTime) {
  try {
    await pool.execute(
      'INSERT INTO debate_records (openid, debate_time, created_at) VALUES (?, ?, ?)',
      [openid, debateTime, Date.now()]
    );
    return true;
  } catch (error) {
    console.error('保存辩论记录到数据库失败:', error);
    // 如果表不存在，不抛出错误，允许继续运行
    if (error.code === 'ER_NO_SUCH_TABLE') {
      console.warn('⚠️ 辩论记录表不存在，将使用内存存储');
      return false;
    }
    return false;
  }
}

// 从数据库加载用户的辩论记录
async function loadDebateRecordsFromDB(openid) {
  try {
    const [rows] = await pool.execute(
      'SELECT debate_time FROM debate_records WHERE openid = ? ORDER BY debate_time ASC',
      [openid]
    );
    
    return rows.map(row => row.debate_time);
  } catch (error) {
    console.error('从数据库加载辩论记录失败:', error);
    // 如果表不存在，返回空数组
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return [];
    }
    return [];
  }
}

// ========== 激活码验证接口 ==========
app.post('/api/member/activate-code', async (req, res) => {
  try {
    const { code, openid } = req.body;

    if (!code || !openid) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数'
      });
    }

    // 验证用户是否存在
    let user = users.get(openid);
    if (!user) {
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          // 自动创建用户
          const newUser = {
            openid: openid,
            memberType: 'FREE',
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0, // 广告奖励的辩论次数
            createdAt: Date.now()
          };
          users.set(openid, newUser);
          user = newUser;
          // 保存到数据库（等待保存完成，确保数据持久化）
          try {
            await saveUserToDB(newUser);
            console.log(`✅ 激活码：新用户已保存到数据库: ${openid}`);
          } catch (err) {
            console.error('保存新用户到数据库失败:', err);
            // 即使保存失败，也继续处理（使用内存存储）
          }
        }
      } catch (error) {
        console.error('加载用户失败，使用内存存储:', error);
        const newUser = {
          openid: openid,
          memberType: 'FREE',
          memberExpireAt: null,
          debatesUsed: 0,
          memberStartAt: null,
          adRewardDebates: 0,
          createdAt: Date.now()
        };
        users.set(openid, newUser);
        user = newUser;
      }
    }

    // 从数据库检查激活码（必须存在于数据库中）
    let codeCheck = { exists: false, codeInfo: null };
    try {
      codeCheck = await checkActivationCode(code);
    } catch (dbError) {
      console.error('数据库查询失败:', dbError);
      // 数据库查询失败，返回错误
      return res.status(500).json({
        ok: false,
        error: '数据库连接失败，无法验证激活码'
      });
    }
    
    // 如果数据库中不存在，直接返回错误
    if (!codeCheck.exists) {
      return res.status(400).json({
        ok: false,
        error: '激活码不存在，请检查激活码是否正确'
      });
    }
    
    // 数据库中存在激活码，获取信息
    const codeInfo = codeCheck.codeInfo;
    let memberType = codeInfo.member_type;
    
    // 检查是否已使用
    if (codeInfo.used === 1) {
      return res.status(400).json({
        ok: false,
        error: '激活码已被使用'
      });
    }
    
    // 检查是否过期（如果有过期时间）
    if (codeInfo.expires_at && Date.now() > codeInfo.expires_at) {
      return res.status(400).json({
        ok: false,
        error: '激活码已过期'
      });
    }

    // 激活码验证通过，激活会员
    const memberConfig = MEMBER_CONFIG[memberType];
    if (!memberConfig) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    // 检查是否可以购买
    const currentMemberType = user.memberType;
    const isMemberValid = user.memberExpireAt && Date.now() < user.memberExpireAt;
    
    // 规则1：超级会员不能降级购买普通会员
    if (currentMemberType === 'SUPER' && memberType === 'NORMAL' && isMemberValid) {
      return res.status(400).json({
        ok: false,
        error: '您已经是超级会员，不能降级使用普通会员激活码'
      });
    }

    // 确保 adRewardDebates 字段存在（激活会员不影响广告奖励次数）
    if (user.adRewardDebates === undefined) {
      user.adRewardDebates = 0;
    }

    // 激活会员
    const now = Date.now();
    const currentExpireAt = user.memberExpireAt;
    const isCurrentValid = currentExpireAt && now < currentExpireAt;

    // 规则2：相同会员类型，不叠加时间，只重置次数
    if (user.memberType === memberType && isCurrentValid) {
      // 保持原到期时间不变，只重置使用次数
      user.debatesUsed = 0;
      console.log(`激活码：会员次数已重置: ${openid}, 类型: ${memberType}`);
    }
    // 规则3：不同会员类型，升级（重置时间）
    else if (user.memberType !== memberType) {
      // 升级会员，重置时间
      const oldMemberType = user.memberType; // 保存旧的会员类型用于日志
      user.memberType = memberType;
      user.memberStartAt = now;
      user.memberExpireAt = now + memberConfig.duration;
      user.debatesUsed = 0;
      console.log(`激活码：会员已升级: ${openid}, 从 ${oldMemberType} 升级到 ${memberType}`);
    }
    // 规则4：会员已过期，重新激活
    else {
      // 会员已过期，重新激活
      user.memberType = memberType;
      user.memberStartAt = now;
      user.memberExpireAt = now + memberConfig.duration;
      user.debatesUsed = 0;
      console.log(`激活码：会员已重新激活: ${openid}, 类型: ${memberType}`);
    }

    // 同步到数据库
    await saveUserToDB(user);

    // 标记激活码为已使用（激活码已确认存在于数据库中）
    try {
      const marked = await markCodeAsUsed(code, openid);
      if (!marked) {
        console.error('⚠️ 警告：激活码标记失败，但会员已激活');
      }
    } catch (markError) {
      console.error('❌ 标记激活码失败（但会员已激活）:', markError);
      console.error('错误详情:', markError.message);
      // 即使标记失败，会员已经激活，所以不返回错误
      // 但记录详细日志以便排查
    }

    res.json({
      ok: true,
      message: '会员已激活',
      memberType: memberType,
      memberName: memberConfig.name,
      expireAt: user.memberExpireAt
    });
  } catch (error) {
    console.error('激活码验证失败:', error);
    console.error('错误堆栈:', error.stack);
    res.status(500).json({
      ok: false,
      error: '激活失败',
      message: error.message || '服务器内部错误',
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// ========== 生成激活码接口（管理员功能） ==========
app.post('/api/admin/generate-code', async (req, res) => {
  try {
    const { memberType, count = 1, expiresAt = null } = req.body;
    
    // 这里可以添加管理员验证逻辑（比如检查 token）
    // const adminToken = req.headers.authorization;
    // if (!isAdmin(adminToken)) {
    //   return res.status(403).json({ ok: false, error: '无权限' });
    // }
    
    if (!memberType || !['NORMAL', 'SUPER'].includes(memberType)) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }
    
    const codes = [];
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    for (let i = 0; i < count; i++) {
      // 生成随机码
      const randomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
      const code = `${memberType}_${dateStr}_${randomCode}`;
      
      // 创建激活码
      const success = await createActivationCode(code, memberType, expiresAt);
      if (success) {
        codes.push(code);
      }
    }
    
    res.json({
      ok: true,
      message: `成功生成 ${codes.length} 个激活码`,
      codes: codes,
      memberType: memberType
    });
  } catch (error) {
    console.error('生成激活码失败:', error);
    res.status(500).json({
      ok: false,
      error: '生成激活码失败'
    });
  }
});

// ========== 待审核订单存储 ==========
if (!global.pendingOrders) {
  global.pendingOrders = new Map();
}

// ========== 审核并激活会员函数 ==========
async function approveOrder(orderId, openid, memberType) {
  try {
    const pendingOrder = global.pendingOrders.get(orderId);
    if (!pendingOrder || pendingOrder.status !== 'PENDING') {
      console.error(`❌ 审核失败：订单 ${orderId} 不存在或已处理`);
      throw new Error(`订单 ${orderId} 不存在或已处理`);
    }

    let targetUser = users.get(openid);
    if (!targetUser) {
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          targetUser = dbUser;
        } else {
          // 如果用户不存在，自动创建用户（异常情况处理）
          console.warn(`⚠️ 审核订单：用户 ${openid} 不存在，自动创建用户`);
          const newUser = {
            openid: openid,
            memberType: 'FREE',
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0,
            createdAt: Date.now()
          };
          users.set(openid, newUser);
          targetUser = newUser;
          // 保存到数据库（等待保存完成，确保数据持久化）
          try {
            await saveUserToDB(newUser);
            console.log(`✅ 审核订单：新用户已保存到数据库: ${openid}`);
          } catch (err) {
            console.error('保存新用户到数据库失败:', err);
            // 即使保存失败，也继续处理（使用内存存储）
          }
        }
      } catch (error) {
        console.error('加载用户失败，使用内存存储:', error);
        const newUser = {
          openid: openid,
          memberType: 'FREE',
          memberExpireAt: null,
          debatesUsed: 0,
          memberStartAt: null,
          adRewardDebates: 0,
          createdAt: Date.now()
        };
        users.set(openid, newUser);
        targetUser = newUser;
      }
    }

    const memberConfig = MEMBER_CONFIG[memberType];
    if (!memberConfig) {
      console.error(`❌ 审核失败：无效的会员类型: ${memberType}`);
      throw new Error(`无效的会员类型: ${memberType}`);
    }

    // 激活会员
    const now = Date.now();
    const currentExpireAt = targetUser.memberExpireAt;
    const isCurrentValid = currentExpireAt && now < currentExpireAt;
    
    console.log('=== 会员激活调试信息 ===');
    console.log('当前会员类型:', targetUser.memberType);
    console.log('购买会员类型:', memberType);
    console.log('当前到期时间:', currentExpireAt ? new Date(currentExpireAt).toISOString() : '无');
    console.log('当前是否有效:', isCurrentValid);

    // 确保 adRewardDebates 字段存在（激活会员不影响广告奖励次数）
    if (targetUser.adRewardDebates === undefined) {
      targetUser.adRewardDebates = 0;
    }

    // 规则2：相同会员类型，不叠加时间，只重置次数
    if (targetUser.memberType === memberType && isCurrentValid) {
      targetUser.debatesUsed = 0;
      console.log(`会员次数已重置: ${openid}, 类型: ${memberType}`);
    }
    // 规则3：不同会员类型，升级（重置时间）
    else if (targetUser.memberType !== memberType) {
      const oldMemberType = targetUser.memberType; // 保存旧的会员类型用于日志
      targetUser.memberType = memberType;
      targetUser.memberStartAt = now;
      targetUser.memberExpireAt = now + memberConfig.duration;
      targetUser.debatesUsed = 0;
      console.log(`会员已升级: ${openid}, 从 ${oldMemberType} 升级到 ${memberType}`);
    }
    // 规则4：会员已过期，重新激活
    else {
      targetUser.memberType = memberType;
      targetUser.memberStartAt = now;
      targetUser.memberExpireAt = now + memberConfig.duration;
      targetUser.debatesUsed = 0;
      console.log(`会员已重新激活: ${openid}, 类型: ${memberType}`);
    }
        
    // 同步到数据库
    await saveUserToDB(targetUser);
    
    // 更新订单状态
    pendingOrder.status = 'APPROVED';
    pendingOrder.approvedAt = Date.now();
    
    console.log(`会员已激活: ${openid}, 类型: ${memberType}, 订单: ${orderId}`);
  } catch (error) {
    console.error('审核订单失败:', error);
    throw error; // 抛出错误，让调用者知道失败
  }
}

// ========== 提交支付凭证接口 ==========
app.post('/api/member/submit-payment', upload.single('image'), async (req, res) => {
  try {
    // 获取表单数据（wx.uploadFile 发送的 formData）
    const orderId = req.body.orderId;
    const memberType = req.body.memberType;
    const transferNote = req.body.transferNote;
    const openid = req.body.openid;
    
    console.log('收到提交请求 - openid:', openid);
    console.log('订单ID:', orderId);
    console.log('会员类型:', memberType);
    console.log('转账备注:', transferNote);
    console.log('是否有图片:', !!req.file);
    if (req.file) {
      console.log('图片信息:', {
        filename: req.file.filename,
        path: req.file.path,
        size: req.file.size
      });
    }

    if (!orderId || !memberType || !openid) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数'
      });
    }

    if (!['NORMAL', 'SUPER'].includes(memberType)) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    // 确保用户存在
    let user = users.get(openid);
    if (!user) {
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          const newUser = {
            openid: openid,
            memberType: 'FREE',
            memberExpireAt: null,
            debatesUsed: 0,
            memberStartAt: null,
            adRewardDebates: 0, // 广告奖励的辩论次数
            createdAt: Date.now()
          };
          users.set(openid, newUser);
          user = newUser;
          // 保存到数据库（等待保存完成，确保数据持久化）
          try {
            await saveUserToDB(newUser);
            console.log(`✅ 提交支付：新用户已保存到数据库: ${openid}`);
          } catch (err) {
            console.error('保存新用户到数据库失败:', err);
            // 即使保存失败，也继续处理（使用内存存储）
          }
        }
      } catch (error) {
        console.error('加载用户失败，使用内存存储:', error);
        const newUser = {
          openid: openid,
          memberType: 'FREE',
          memberExpireAt: null,
          debatesUsed: 0,
          memberStartAt: null,
          adRewardDebates: 0,
          createdAt: Date.now()
        };
        users.set(openid, newUser);
        user = newUser;
      }
    }

    const memberConfig = MEMBER_CONFIG[memberType];
    if (!memberConfig) {
      return res.status(400).json({
        ok: false,
        error: '无效的会员类型'
      });
    }

    // 保存订单信息
    const imagePath = req.file ? req.file.path : null;
    const orderData = {
      orderId: orderId,
      openid: openid,
      memberType: memberType,
      price: memberConfig.price,
      transferNote: transferNote || '',
      imagePath: imagePath,
      status: 'PENDING', // PENDING, APPROVED, REJECTED
      createdAt: Date.now()
    };

    global.pendingOrders.set(orderData.orderId, orderData);

    // 审核逻辑：全部需要人工审核
    console.log('订单审核：订单已提交，等待人工审核');
    console.log('订单信息:', {
      orderId: orderData.orderId,
      openid: openid,
      memberType: memberType,
      hasImage: !!imagePath,
      hasNote: !!transferNote
    });

    res.json({
      ok: true,
      message: '凭证已提交，等待人工审核',
      orderId: orderData.orderId
    });
  } catch (error) {
    console.error('提交支付凭证失败:', error);
    console.error('错误堆栈:', error.stack);
    console.error('请求信息:', {
      body: req.body,
      file: req.file ? {
        filename: req.file.filename,
        path: req.file.path
      } : null
    });
    res.status(500).json({
      ok: false,
      error: '提交失败：' + (error?.message || error?.toString() || '未知错误')
    });
  }
});

// multer 错误处理中间件
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('Multer 错误:', error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        ok: false,
        error: '文件大小超过限制（最大5MB）'
      });
    }
    return res.status(400).json({
      ok: false,
      error: '文件上传失败：' + (error?.message || error?.toString() || '未知错误')
    });
  }
  next(error);
});

// ========== 查询支付状态接口 ==========
app.get('/api/member/payment-status', (req, res) => {
  try {
    const { orderId, openid } = req.query;
    
    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: '缺少订单号'
      });
    }

    if (!global.pendingOrders || !global.pendingOrders.has(orderId)) {
      return res.status(404).json({
        ok: false,
        error: '订单不存在'
      });
    }

    const order = global.pendingOrders.get(orderId);
    
    if (openid && order.openid !== openid) {
      return res.status(403).json({
        ok: false,
        error: '无权访问此订单'
      });
    }

    let status = 'pending'; // 前端使用的状态
    let statusText = '待审核';
    
    if (order.status === 'APPROVED') {
      status = 'activated';
      statusText = '已激活';
    } else if (order.status === 'REJECTED') {
      status = 'failed';
      statusText = '审核失败';
    } else if (order.status === 'PENDING') {
      status = 'reviewing';
      statusText = '审核中';
    }

    res.json({
      ok: true,
      status: status,
      statusText: statusText,
      order: {
        orderId: order.orderId,
        memberType: order.memberType,
        price: order.price || (MEMBER_CONFIG[order.memberType]?.price || 0),
        status: order.status,
        createdAt: order.createdAt,
        approvedAt: order.approvedAt,
        transferNote: order.transferNote,
        hasImage: !!order.imagePath
      }
    });
  } catch (error) {
    console.error('查询支付状态失败:', error);
    res.status(500).json({
      ok: false,
      error: '查询支付状态失败'
    });
  }
});

// ========== 查看所有待审核订单接口（管理员） ==========
app.get('/api/admin/pending-orders', (req, res) => {
  try {
    if (!global.pendingOrders) {
      return res.json({
        ok: true,
        orders: []
      });
    }

    // 获取所有待审核订单
    const pendingOrders = [];
    global.pendingOrders.forEach((order, orderId) => {
      if (order.status === 'PENDING') {
        pendingOrders.push({
          orderId: order.orderId,
          openid: order.openid,
          memberType: order.memberType,
          memberName: MEMBER_CONFIG[order.memberType]?.name || order.memberType,
          price: order.price,
          transferNote: order.transferNote,
          hasImage: !!order.imagePath,
          imagePath: order.imagePath,
          createdAt: order.createdAt,
          createdAtFormatted: new Date(order.createdAt).toLocaleString('zh-CN')
        });
      }
    });

    // 按创建时间倒序排列
    pendingOrders.sort((a, b) => b.createdAt - a.createdAt);

    res.json({
      ok: true,
      count: pendingOrders.length,
      orders: pendingOrders
    });
  } catch (error) {
    console.error('查询待审核订单失败:', error);
    res.status(500).json({
      ok: false,
      error: '查询失败'
    });
  }
});

// ========== 管理员审核订单接口 ==========
app.post('/api/admin/approve-order', async (req, res) => {
  try {
    const { orderId, action } = req.body; // action: 'approve' 或 'reject'
    
    if (!orderId || !action) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数'
      });
    }

    if (!global.pendingOrders || !global.pendingOrders.has(orderId)) {
      return res.status(404).json({
        ok: false,
        error: '订单不存在'
      });
    }

    const order = global.pendingOrders.get(orderId);
    
    if (order.status !== 'PENDING') {
      return res.status(400).json({
        ok: false,
        error: '订单已处理'
      });
    }

    if (action === 'approve') {
      try {
        // 审核通过，激活会员
        await approveOrder(orderId, order.openid, order.memberType);
        res.json({
          ok: true,
          message: '订单已审核通过，会员已激活'
        });
      } catch (error) {
        console.error('激活会员失败:', error);
        res.status(500).json({
          ok: false,
          error: '激活会员失败：' + (error?.message || error?.toString() || '未知错误')
        });
      }
    } else if (action === 'reject') {
      // 审核拒绝
      order.status = 'REJECTED';
      order.rejectedAt = Date.now();
      res.json({
        ok: true,
        message: '订单已拒绝'
      });
    } else {
      return res.status(400).json({
        ok: false,
        error: '无效的操作'
      });
    }
  } catch (error) {
    console.error('审核订单失败:', error);
    res.status(500).json({
      ok: false,
      error: '审核失败'
    });
  }
});

// ========== 查看订单截图接口 ==========
app.get('/api/admin/order-image/:orderId', (req, res) => {
  try {
    const { orderId } = req.params;
    
    if (!global.pendingOrders || !global.pendingOrders.has(orderId)) {
      return res.status(404).json({
        ok: false,
        error: '订单不存在'
      });
    }

    const order = global.pendingOrders.get(orderId);
    
    if (!order.imagePath) {
      return res.status(404).json({
        ok: false,
        error: '订单没有截图'
      });
    }

    // 检查文件是否存在
    if (!fs.existsSync(order.imagePath)) {
      return res.status(404).json({
        ok: false,
        error: '截图文件不存在'
      });
    }

    // 返回图片文件
    res.sendFile(path.resolve(order.imagePath));
  } catch (error) {
    console.error('获取订单截图失败:', error);
    res.status(500).json({
      ok: false,
      error: '获取截图失败'
    });
  }
});

// ========== 查询订单状态接口 ==========
app.get('/api/member/order-status', (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({
        ok: false,
        error: '缺少订单号'
      });
    }

    if (!global.orders || !global.orders.has(orderId)) {
      return res.status(404).json({
        ok: false,
        error: '订单不存在'
      });
    }

    const order = global.orders.get(orderId);

    res.json({
      ok: true,
      order: {
        orderId: order.orderId,
        memberType: order.memberType,
        price: order.price,
        status: order.status,
        createdAt: order.createdAt
      }
    });
  } catch (error) {
    console.error('查询订单状态失败:', error);
    res.status(500).json({
      ok: false,
      error: '查询订单状态失败'
    });
  }
});

// ========== 主接口：生成下一轮辩论 ==========
app.post('/api/debate/next-round', async (req, res) => {
  try {
    const { config, currentRound, provider = 'deepseek', history = [], openid } = req.body || {};
    
    // 参数验证
    if (!config || !config.topic) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要参数：config.topic'
      });
    }

    // 会员验证
    if (!openid) {
      return res.status(401).json({
        ok: false,
        error: '请先登录',
        needLogin: true
      });
    }

    // 获取用户信息
    let user = users.get(openid);
    if (!user) {
      // 尝试从数据库加载
      try {
        const dbUser = await loadUserFromDB(openid);
        if (dbUser) {
          users.set(openid, dbUser);
          user = dbUser;
        } else {
          return res.status(401).json({
            ok: false,
            error: '用户不存在，请先登录',
            needLogin: true
          });
        }
      } catch (error) {
        console.error('从数据库加载用户失败:', error);
        return res.status(401).json({
          ok: false,
          error: '用户不存在，请先登录',
          needLogin: true
        });
      }
    }

    // 检查是否有正在处理的请求（防止并发请求导致重复消耗次数）
    // 注意：必须在检查会员状态之前检查锁，避免在降级过程中产生竞态条件
    if (debateLocks.get(openid)) {
      return res.status(429).json({
        ok: false,
        error: '请求过于频繁，请稍后再试',
        errorCode: 'rate_limit'
      });
    }

    // 设置请求锁（带超时机制，防止永久锁定）
    debateLocks.set(openid, true);
    // 设置超时释放锁（30秒后自动释放，防止永久锁定）
    const lockTimeout = setTimeout(() => {
      debateLocks.delete(openid);
      console.warn(`⚠️ 请求锁超时自动释放: ${openid}`);
    }, 30000); // 30秒超时

    try {
      // 检查会员状态（如果过期，降级为普通用户）
      // 注意：在锁内检查，避免并发请求时的竞态条件
      if (user.memberType !== 'FREE' && !isMemberValid(user)) {
        user.memberType = 'FREE';
        user.memberExpireAt = null;
        user.debatesUsed = 0;
        // 确保 adRewardDebates 字段存在（会员过期不影响广告奖励次数）
        if (user.adRewardDebates === undefined) {
          user.adRewardDebates = 0;
        }
        // 同步到数据库（异步，不阻塞）
        saveUserToDB(user).catch(err => {
          console.error('更新用户到数据库失败:', err);
        });
      }

      // 检查是否可以辩论
      const canDebateResult = canDebate(user, config);
      if (!canDebateResult.can) {
        clearTimeout(lockTimeout);
        debateLocks.delete(openid); // 释放锁
        return res.status(403).json({
          ok: false,
          error: canDebateResult.reason,
          needMember: requiresMember(config),
          userInfo: {
            memberType: user.memberType,
            todayDebates: getTodayDebates(openid),
            maxDebates: getMaxDebates(user),
            debatesUsed: user.debatesUsed,
            adRewardDebates: user.adRewardDebates || 0
          }
        });
      }

      // 先消耗次数（每次点击"继续生成"都消耗一次）
      // 这样可以防止用户通过不断返回再点击来绕过限制
      recordDebate(openid);

      const round = currentRound || 1;
      const systemPrompt = buildSystemPrompt(config);
      const userPrompt = buildUserPrompt(round, history);
      
      const historyMessages = Array.isArray(history) ? history : [];

      let result;
      
      try {
        if (provider === 'deepseek') {
          console.log(`使用 DeepSeek 生成第 ${round} 轮，历史消息数：${historyMessages.length}`);
          result = await callDeepSeek(systemPrompt, userPrompt, historyMessages);
        } else {
          console.log(`使用豆包生成第 ${round} 轮，历史消息数：${historyMessages.length}`);
          result = await callDouBao(systemPrompt, userPrompt, historyMessages);
        }
      } catch (error) {
        // 如果生成失败，需要回滚次数消耗
        // 注意：由于 recordDebate 是异步的，这里无法完全回滚，但至少记录日志
        console.error('生成辩论内容失败，但次数已消耗:', error);
        // 抛出错误，让外层处理
        throw error;
      }

      // 清除超时定时器
      clearTimeout(lockTimeout);
      
      // 释放请求锁（延迟释放，防止快速连续请求）
      setTimeout(() => {
        debateLocks.delete(openid);
      }, 1000); // 1秒后释放锁

      res.json({
        ok: true,
        round,
        A: result.A || '（生成失败）',
        B: result.B || '（生成失败）'
      });
    } catch (error) {
      // 清除超时定时器
      clearTimeout(lockTimeout);
      // 确保在错误时也释放锁
      debateLocks.delete(openid);
      console.error('生成辩论失败:', error);
    
      // 根据错误类型返回不同的错误信息
      let errorMessage = '生成失败，请稍后重试';
      let errorCode = 'server_error';
      
      // 安全获取错误信息
      const errorMsg = error?.message || error?.toString() || '未知错误';
      
      if (errorMsg.includes('API错误')) {
        if (errorMsg.includes('401') || errorMsg.includes('Unauthorized')) {
          errorMessage = 'API Key 无效，请检查配置';
          errorCode = 'api_key_error';
        } else if (errorMsg.includes('402') || errorMsg.includes('Insufficient Balance')) {
          errorMessage = '账户余额不足，请充值后再试';
          errorCode = 'insufficient_balance';
        } else if (errorMsg.includes('404') || errorMsg.includes('Not Found')) {
          errorMessage = 'API 地址或模型不存在，请检查配置';
          errorCode = 'api_not_found';
        } else if (errorMsg.includes('429') || errorMsg.includes('rate limit')) {
          errorMessage = '请求过于频繁，请稍后再试';
          errorCode = 'rate_limit';
        } else {
          errorMessage = 'AI 服务调用失败，请稍后重试';
          errorCode = 'api_error';
        }
      } else if (errorMsg.includes('网络') || errorMsg.includes('network') || errorMsg.includes('timeout')) {
        errorMessage = '网络连接失败，请检查网络后重试';
        errorCode = 'network_error';
      }
      
      res.status(500).json({
        ok: false,
        error: errorCode,
        message: errorMessage
      });
    }
  } catch (error) {
    // 外层错误处理（处理锁设置之前的错误）
    console.error('辩论接口外层错误:', error);
    res.status(500).json({
      ok: false,
      error: 'server_error',
      message: '服务器内部错误：' + (error?.message || error?.toString() || '未知错误')
    });
  }
});

// ========== 调用微信支付统一下单接口 ==========
async function callWeChatPay(params) {
  const xml2js = require('xml2js');
  
  // 将参数转换为 XML
  const builder = new xml2js.Builder();
  const xml = builder.buildObject({
    xml: params
  });

  const response = await fetch('https://api.mch.weixin.qq.com/pay/unifiedorder', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/xml'
    },
    body: xml
  });

  const xmlText = await response.text();
  
  // 解析 XML
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlText);
  
  return result.xml;
}

// ========== 启动时从数据库加载数据 ==========
async function initializeFromDatabase() {
  try {
    // 加载所有用户到内存
    await loadAllUsersFromDB();
    console.log('✅ 数据库初始化完成');
  } catch (error) {
    console.error('❌ 数据库初始化失败:', error);
    console.log('⚠️ 将使用内存存储模式（数据不会持久化）');
  }
}

// ========== 启动服务器 ==========
initializeFromDatabase().then(() => {
  app.listen(PORT, () => {
    console.log(`Debate server listening on http://localhost:${PORT}`);
    console.log('请确保已配置 DOU_BAO_API_KEY 和 DEEPSEEK_API_KEY');
  });
}).catch(error => {
  console.error('启动失败:', error);
  // 即使初始化失败，也启动服务器（使用内存模式）
  app.listen(PORT, () => {
    console.log(`Debate server listening on http://localhost:${PORT}`);
    console.log('⚠️ 数据库初始化失败，使用内存存储模式');
    console.log('请确保已配置 DOU_BAO_API_KEY 和 DEEPSEEK_API_KEY');
  });
});