/* 서버와 브라우저가 함께 쓰는 점수 계산 로직 (단일 출처) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SP = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const DEFAULT_COLORS = [
    { key: 'yellow', name: '노랑' },
    { key: 'green', name: '초록' },
    { key: 'red', name: '빨강' },
    { key: 'blue', name: '파랑' },
    { key: 'white', name: '하양' },
  ];

  // 평등위_스타 파워 문서의 점수표 (색상 x 개수)
  const DEFAULT_TABLE = {
    yellow: [8, 16, 24, 32, 40],
    green: [4, 8, 12, 16, 20],
    red: [3, 6, 9, 14, 18],
    blue: [2, 4, 6, 13, 17],
    white: [1, 2, 3, 12, 16],
  };

  // chips: ['yellow','white',...]  table: {yellow:[n=1점, n=2점, ...]}
  // 색상별로 가진 개수에 해당하는 점수를 찾아 모두 더한다. (누적이 아닌 현재 조합 기준)
  function calcScore(chips, table) {
    const cnt = {};
    for (const c of chips) cnt[c] = (cnt[c] || 0) + 1;
    let total = 0;
    const parts = [];
    for (const key of Object.keys(table)) {
      const n = cnt[key] || 0;
      if (!n) continue;
      const arr = table[key] || [];
      const pts = Number(arr[Math.min(n, arr.length) - 1]) || 0;
      total += pts;
      parts.push({ key, n, pts });
    }
    return { total, parts };
  }

  // "2008-05-12", "2008.5", "2008" -> 정렬용 숫자 (빠를수록 작음). 비어 있으면 가장 뒤.
  function dateKey(s) {
    const nums = String(s || '').match(/\d+/g);
    if (!nums) return 99999999;
    const y = Number(nums[0]) || 0;
    const m = Number(nums[1]) || 0;
    const d = Number(nums[2]) || 0;
    return y * 10000 + m * 100 + d;
  }

  // 칩을 정확히 n개 가졌을 때 나올 수 있는 가장 낮은 점수 (보너스 칩 제외). 점수표 기본값과 5개면 7점(하양 3 + 파랑 2)
  function minPossibleScore(table, n) {
    const keys = Object.keys(table);
    const INF = Infinity;
    let dp = Array(n + 1).fill(INF); dp[0] = 0;
    for (const k of keys) {
      const next = Array(n + 1).fill(INF);
      for (let used = 0; used <= n; used++) {
        if (dp[used] === INF) continue;
        for (let c = 0; used + c <= n; c++) {
          const cost = c === 0 ? 0 : Number(table[k][c - 1]);
          if (!Number.isFinite(cost)) continue;
          next[used + c] = Math.min(next[used + c], dp[used] + cost);
        }
      }
      dp = next;
    }
    return dp[n] === INF ? 0 : dp[n];
  }

  // 순위 변화: 양수면 순위가 올라감(숫자가 작아짐), 음수면 내려감, 0이면 그대로, null이면 비교할 직전 순위가 없음
  function rankDelta(prevRank, rank) {
    if (prevRank == null || rank == null) return null;
    return prevRank - rank;
  }

  // 감옥 아이콘 (창살). 글꼴에 따라 이모지가 다르게 보이지 않도록 SVG 로 그린다.
  function jailIcon(size) {
    const z = size || 16;
    return `<svg class="jail" width="${z}" height="${z}" viewBox="0 0 16 16" role="img" aria-label="수감 중" focusable="false" style="vertical-align:-3px;flex:none"><title>수감 중</title><rect x="1.5" y="1.5" width="13" height="13" rx="2.5" fill="#3b3f4a" stroke="#ffffff" stroke-width="1"/><path d="M5 3v10M8 3v10M11 3v10" stroke="#e8eaf0" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  }

  return { rankDelta, jailIcon, DEFAULT_COLORS, DEFAULT_TABLE, calcScore, dateKey, minPossibleScore };
});
