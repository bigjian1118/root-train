// 注册密码规则校验（纯工具函数，无业务逻辑）。
// 规则与后端 server/security.py validate_password_policy 完全一致，改动需两侧同步。

export const PASSWORD_MIN_LENGTH = 6;
export const PASSWORD_MAX_LENGTH = 20;

const ALLOWED_CHARS_PATTERN =
  /^[0-9a-zA-Z!@#$%^&*()_+\-=\[\]{};':",.<>/?~`\\| ]+$/;
const REPEATED_CHAR_PATTERN = /(.)\1{5,}/;

/** 返回第一条不符合规则的提示文案；全部通过返回 null。 */
export function validatePassword(password: string): string | null {
  if (!password) {
    return '请设置登录密码';
  }
  if (password.trim() === '') {
    return '密码不能为纯空格';
  }
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return `密码长度需为 ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} 位`;
  }
  if (!ALLOWED_CHARS_PATTERN.test(password)) {
    return '密码仅支持数字、大小写字母和常用特殊符号';
  }
  if (REPEATED_CHAR_PATTERN.test(password)) {
    return '密码不能包含连续 6 位以上相同字符';
  }
  return null;
}

/** 两次密码一致性（大小写敏感）；第二个输入为空时不提示，避免打断输入。 */
export function validatePasswordMatch(
  password: string,
  confirm: string,
): string | null {
  if (confirm && password !== confirm) {
    return '两次输入的密码不一致';
  }
  return null;
}
