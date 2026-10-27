// 工具声明：美团点金调价助手（在应用自带窗口里登录美团商家后台，读点金数据，本机算每小时预算与出价建议；自动保存默认关闭）。
import { Gauge } from 'lucide-react';
import { createElement } from 'react';
import type { CustomTool } from '../kit/types';
import { Main } from './Main';

const tool: CustomTool = {
  id: 'e35',
  name: '美团点金调价助手',
  tagline: '按昨日曝光分配每小时推广预算，给出点金出价建议；默认只提建议，自动保存出价需要你手动打开。',
  icon: Gauge,
  category: '电商运营',
  type: 'data',
  mode: 'custom',
  mainLabel: '调价助手',
  params: [],
  Main: ({ ctx }) => createElement(Main, { ctx }),
};

export default tool;
