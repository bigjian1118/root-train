'use client';

import Link from 'next/link';

import { AppShell } from '@/components/business/app-shell';
import { AuthGuard } from '@/components/business/auth-guard';

// 1:1 复刻旧版 static/test_select.html：量表选择页仅一张 SCL-90 卡片，点击进入答题页。
function TestContent() {
  return (
    <AppShell
      role="student"
      pageClassName="mx-auto min-h-screen max-w-[860px] px-[36px] pb-[70px] pt-[20px]"
    >
      <h1 className="aic-page-title">心理测评选择</h1>
      <p className="aic-page-sub">
        请根据自身情况选择量表进行测评，测评结果仅作为心理健康筛查参考。
      </p>

      <div className="aic-scale-list">
        <Link className="aic-scale-card" href="/test/scl90">
          <div className="aic-scale-emoji">📋</div>
          <div className="aic-scale-body">
            <h3>SCL-90症状自评量表</h3>
            <div className="aic-scale-meta">
              <span className="aic-chip aic-chip-green">适用人群：高中生及大学生</span>
              <span className="aic-chip aic-chip-gold">共 90 题</span>
            </div>
            <p>适用于高中生及大学生，共90题，深度心理健康筛查。</p>
          </div>
          <span className="aic-scale-btn">点击进入 →</span>
        </Link>
      </div>
    </AppShell>
  );
}

export default function TestPage() {
  return (
    <AuthGuard role="student">
      <TestContent />
    </AuthGuard>
  );
}
