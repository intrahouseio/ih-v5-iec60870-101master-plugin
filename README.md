# IEC 60870-5-101 Master Plugin for IntraSCADA

Плагин для [IntraSCADA](https://intrascada.ru) v5, реализующий **master (клиент)** по протоколу
**IEC 60870-5-101** в **unbalanced**-режиме. Работает через последовательный порт (RS-232/RS-485)
и поддерживает несколько slave-устройств на одной линии.

## Возможности

- ✅ Несколько slave на одной шине (round-robin polling)
- ✅ Class 1 и Class 2 polling (FCB чередование)
- ✅ Общий опрос (`C_IC_NA_1`, TypeID=100, COT=6)
- ✅ Синхронизация времени (`C_CS_NA_1`, TypeID=103)
- ✅ Спонтанные данные (COT=3) и ответы на опрос (COT=20)
- ✅ Управляющие команды:
  - `C_SC_NA_1` (45) — Single Command
  - `C_DC_NA_1` (46) — Double Command
  - `C_RC_NA_1` (47) — Regulating Step Command
  - `C_SE_NA_1` (48) — Setpoint Normalized
  - `C_SE_NB_1` (49) — Setpoint Scaled
  - `C_SE_NC_1` (50) — Setpoint Short Float
  - `C_BO_NA_1` (51) — Bitstring 32
  - С метками времени: `C_SC_TA_1` (58), `C_DC_TA_1` (59), `C_RC_TA_1` (60),
    `C_SE_TA_1` (61), `C_SE_TB_1` (62), `C_SE_TC_1` (63), `C_BO_TA_1` (64)
- ✅ Select-Before-Operate (SBO) для команд управления
- ✅ Приём телеметрии: `M_SP_NA_1`, `M_SP_TB_1`, `M_DP_NA_1`, `M_DP_TB_1`,
  `M_ME_NA_1`, `M_ME_NB_1`, `M_ME_NC_1`, `M_ME_TD_1`, `M_ME_TE_1`, `M_ME_TF_1`,
  `M_IT_NA_1`, `M_IT_TB_1`, `M_BO_NA_1`, `M_BO_TB_1`, `M_ST_NA_1`, `M_ST_TB_1`
- ✅ Автоматическая реконнекция при потере связи
- ✅ Динамическое добавление slave через UI
- ✅ Сканирование каналов (Scanner)
- ✅ Настраиваемые тайминги t0/t1/t2 и размеры полей ASDU
- ✅ Часовой пояс устройства и автоматическая временная синхронизация
- ✅ Поддержка `chstatus` (индикация ошибок канала)
- ✅ Нативная реализация на C++ (Node.js addon через N-API)

## Установка

### 1. Требования

- **IntraSCADA v5.18+**
- **Node.js 20.x** (для runtime плагина — обычно уже есть в IntraSCADA)
- Нативные бинарники `ih-lib60870-node` (устанавливаются автоматически)

### 2. Установка плагина

**Способ 1 — через дашборд IntraSCADA:**

1. Откройте Project Manager → вкладка **Плагины**
2. Нажмите **Проверить обновления**
3. Найдите `iec60870-101master` в списке
4. Нажмите **Установить**

**Способ 2 — вручную (для разработки):**

```bash
cd /var/lib/intrascada/plugins/
git clone https://github.com/intrahouseio/ih-v5-iec60870-101master-plugin.git iec60870-101master
cd iec60870-101master
npm install