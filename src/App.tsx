/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  LayoutDashboard, PackagePlus, HardHat, Box, Users, RotateCcw, BookOpen, BarChart3, Settings, LogOut, Cpu, Zap, Truck, AlertCircle
} from 'lucide-react';
import {
  sendTelegramMessage,
  formatExitMessage, formatPpeMessage, formatWelcomeMessage, formatLogoutMessage,
  formatReturnLoanMessage, formatEditRecordMessage, formatDeleteRequestMessage,
  formatProductActionMessage, formatPersonnelActionMessage, formatUserActionMessage,
  formatRestoreMessage, sendTelegramBackup
} from './services/telegramService';
import { AuthScreen }            from './components/AuthScreen';
import { DashboardView }         from './components/DashboardView';
import { GeneralExitForm }       from './components/GeneralExitForm';
import { SafetyIssuanceForm }    from './components/SafetyIssuanceForm';
import { WarehouseManager }      from './components/WarehouseManager';
import { PersonnelManager }      from './components/PersonnelManager';
import { LoanManager }           from './components/LoanManager';
import { GlobalLogView }         from './components/GlobalLogView';
import { ReportingView }         from './components/ReportingView';
import { SystemSettings }        from './components/SystemSettings';
import { UnregisteredExitsView } from './components/UnregisteredExitsView';
import { WaybillManager }        from './components/WaybillManager';
import { AIAssistantOverlay }    from './components/AIAssistantOverlay';
import { RecordOverlay }         from './components/RecordOverlay';
import { EditOverlay }           from './components/EditOverlay';
import { ModificationAuthModal } from './components/ModificationAuthModal';
import { SignatureModal }        from './components/SignatureModal';
import { CameraModal }           from './components/CameraModal';
import { User, UserRole, Product, ExitRecord, Recipient, Waybill } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────
interface AppData {
  products:   Product[];
  exits:      ExitRecord[];
  recipients: Recipient[];
  ppeRecords: ExitRecord[];
  waybills:   Waybill[];
  users:      User[];
}

const SESSION_KEY = 'P21_SESSION';

const DEFAULT_USERS: User[] = [
  { id: '1', username: 'sadegh',  password: 'p21admin', fullName: 'صادق محمدی',    role: UserRole.ADMIN,    modPassword: '21'  },
  { id: '2', username: 'مهران',   password: '123',      fullName: 'مهران رستگاری', role: UserRole.OPERATOR, modPassword: '123' },
];

const EMPTY_DATA: AppData = {
  products: [], exits: [], recipients: [], ppeRecords: [], waybills: [], users: [],
};

// ─── Sync helpers (outside component — no closure bugs) ──────────────────────
// _dirty: counts saves in-flight or debouncing. Poller skips while _dirty > 0.
// _localUpdatedAt: timestamp of our last successful save. Poller only applies
//   server data that is NEWER than our local saves — prevents overwriting fresh
//   local changes with stale server snapshots.
let _dirty          = 0;
let _timer: ReturnType<typeof setTimeout> | null = null;
let _localUpdatedAt = 0;   // set after each successful POST

function _doSave(data: AppData) {
  _dirty += 1;
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(() => {
    const body = JSON.stringify(data);
    fetch('/api/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
      .then(r => r.json())
      .then(res => { if (res?.updatedAt) _localUpdatedAt = res.updatedAt; })
      .catch(() => {})
      .finally(() => { _dirty = Math.max(0, _dirty - 1); });
  }, 200);
}

function _parseServer(raw: any): AppData {
  return {
    users:      Array.isArray(raw.users)      && raw.users.length      > 0 ? raw.users      : DEFAULT_USERS,
    products:   Array.isArray(raw.products)   ? raw.products   : [],
    exits:      Array.isArray(raw.exits)      ? raw.exits      : [],
    recipients: Array.isArray(raw.recipients) ? raw.recipients : [],
    ppeRecords: Array.isArray(raw.ppeRecords) ? raw.ppeRecords : [],
    waybills:   Array.isArray(raw.waybills)   ? raw.waybills   : [],
  };
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab]         = useState('dashboard');
  const [ready, setReady]     = useState(false);
  const [data, setData]       = useState<AppData>(EMPTY_DATA);
  const [currentUser, setCurrentUser] = useState<User | null>(() => {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; }
  });

  const [selectedRecord, setSelectedRecord] = useState<ExitRecord | null>(null);
  const [editingRecord,  setEditingRecord]  = useState<ExitRecord | null>(null);
  const [secCtx, setSecCtx] = useState<{ action: () => void; desc: string } | null>(null);
  const [aiOpen,   setAiOpen]   = useState(false);
  const [signOpen, setSignOpen] = useState(false);
  const [camOpen,  setCamOpen]  = useState(false);
  const [tempSig,  setTempSig]  = useState('');
  const [tempPhoto,setTempPhoto]= useState<string | null>(null);

  // Always-current ref for use in async callbacks
  const dataRef        = useRef<AppData>(data);
  const currentUserRef = useRef(currentUser);
  useEffect(() => { dataRef.current = data; });
  useEffect(() => { currentUserRef.current = currentUser; }, [currentUser]);

  // Persist session
  useEffect(() => {
    if (currentUser) localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser));
    else localStorage.removeItem(SESSION_KEY);
  }, [currentUser]);

  // ── THE key helper: update data + immediately save ATOMICALLY ───────────
  // `fn` receives the full current AppData and returns the new AppData.
  // Because we use the functional form of setData, `prev` is ALWAYS the
  // real current state — no stale closure problem.
  const update = useCallback((fn: (prev: AppData) => AppData) => {
    setData(prev => {
      const next = fn(prev);
      _doSave(next);          // save the COMPLETE new state right away
      return next;
    });
  }, []);

  // ── Poller ────────────────────────────────────────────────────────────────
  useEffect(() => {
    let firstLoad = true;

    const applyServer = (raw: any) => {
      const incoming = _parseServer(raw);

      // Only apply server data if it is genuinely newer than our local save.
      // This prevents the poller from overwriting changes the user just made
      // in the tiny window between a save completing and the next poll arriving.
      const serverTs: number = raw._serverUpdatedAt ?? 0;
      if (serverTs > 0 && serverTs <= _localUpdatedAt) return;

      setData(incoming);

      // Refresh currentUser if the server has newer info for them
      const cu = currentUserRef.current;
      if (cu) {
        const fresh = incoming.users.find((u: any) => u.id === cu.id);
        if (fresh && JSON.stringify(fresh) !== JSON.stringify(cu)) {
          setCurrentUser(fresh);
        }
      }
    };

    const poll = () => {
      // Skip entirely while saves are pending or in-flight
      if (_dirty > 0) return;

      fetch('/api/state')
        .then(r => r.json())
        .then(raw => {
          if (_dirty > 0) return;  // re-check after network round-trip
          applyServer(raw);

          // On first load: if server has no users, seed DEFAULT_USERS immediately
          if (firstLoad && !(Array.isArray(raw.users) && raw.users.length > 0)) {
            const seeded = _parseServer(raw);
            setData(seeded);
            _doSave(seeded);
          }
        })
        .catch(() => {})
        .finally(() => {
          if (firstLoad) { firstLoad = false; setReady(true); }
        });
    };

    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, []);

  // Sync currentUser whenever users list changes from server poll
  useEffect(() => {
    if (!currentUser || data.users.length === 0) return;
    const fresh = data.users.find(u => u.id === currentUser.id);
    if (fresh && JSON.stringify(fresh) !== JSON.stringify(currentUser)) {
      setCurrentUser(fresh);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.users]);

  // ── Auth ──────────────────────────────────────────────────────────────────
  const handleLogout = () => {
    if (currentUser) sendTelegramMessage(formatLogoutMessage(currentUser), true);
    setCurrentUser(null);
    setTab('dashboard');
  };

  // ── Security modal ────────────────────────────────────────────────────────
  const secCheck = (action: () => void, desc: string) => setSecCtx({ action, desc });

  // ── Delete ────────────────────────────────────────────────────────────────
  const requestDelete = (type: string, id: string) => {
    const op = currentUser?.fullName || 'System';
    const d = dataRef.current;
    let target: any =
      type === 'EXIT'      ? d.exits.find(e => e.id === id) :
      type === 'PPE'       ? d.ppeRecords.find(p => p.id === id) :
      type === 'PRODUCT'   ? d.products.find(p => p.code === id) :
      type === 'RECIPIENT' ? d.recipients.find(r => r.fullName === id) : null;

    if (currentUser?.role !== UserRole.ADMIN && (type === 'EXIT' || type === 'PPE')) {
      if (target?.delivererName !== currentUser?.fullName) {
        alert('شما فقط مجاز به حذف اسناد ثبت شده توسط خودتان هستید.');
        return;
      }
    }
    secCheck(() => {
      update(prev => ({
        ...prev,
        exits:      type === 'EXIT'      ? prev.exits.filter(e => e.id !== id)          : prev.exits,
        ppeRecords: type === 'PPE'       ? prev.ppeRecords.filter(p => p.id !== id)     : prev.ppeRecords,
        products:   type === 'PRODUCT'   ? prev.products.filter(p => p.code !== id)     : prev.products,
        recipients: type === 'RECIPIENT' ? prev.recipients.filter(r => r.fullName !== id): prev.recipients,
      }));
      sendTelegramMessage(formatDeleteRequestMessage(type, id, op, target), true);
    }, `تایید نهایی حذف ${type === 'EXIT' || type === 'PPE' ? 'سند' : 'داده'}: ${id}`);
  };

  const requestEdit = (record: ExitRecord) => {
    if (currentUser?.role !== UserRole.ADMIN && record.delivererName !== currentUser?.fullName) {
      alert('شما فقط مجاز به ویرایش اسناد ثبت شده توسط خودتان هستید.');
      return;
    }
    setEditingRecord(record);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (!ready) return (
    <div className="min-h-screen flex items-center justify-center text-white">
      <div className="flex flex-col items-center gap-4">
        <Cpu size={48} className="text-indigo-400 animate-pulse" />
        <p className="text-white/50 font-black tracking-widest text-sm">در حال بارگذاری...</p>
      </div>
    </div>
  );

  // Always pass at least DEFAULT_USERS so login works even before server responds
  const loginUsers = data.users.length > 0 ? data.users : DEFAULT_USERS;

  if (!currentUser) return (
    <AuthScreen
      users={loginUsers}
      onLogin={u => { setCurrentUser(u); sendTelegramMessage(formatWelcomeMessage(u), true); }}
    />
  );

  const { products, exits, recipients, ppeRecords, waybills, users } = data;

  return (
    <div className="min-h-screen text-white pb-10">
      {/* ── NAV ── */}
      <nav className="glass-panel sticky top-0 z-50 px-8 py-2.5 flex flex-col md:flex-row justify-between items-center mb-6 no-print border-b border-white/10 shadow-[0_0_50px_rgba(99,102,241,0.15)]">
        <div className="flex items-center gap-6">
          <div className="relative group">
            <div className="absolute -inset-1 bg-gradient-to-r from-indigo-600 via-cyan-500 to-indigo-600 rounded-2xl blur opacity-30 group-hover:opacity-100 transition duration-1000"></div>
            <div className="relative w-12 h-12 bg-black rounded-2xl flex items-center justify-center border border-white/20 shadow-inner"><Cpu size={28} className="text-indigo-400"/></div>
          </div>
          <div className="flex flex-col">
            <h1 className="text-2xl font-black ultra-glow-text tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-white via-indigo-100 to-cyan-100 uppercase">P21 WAREHOUSE</h1>
            <div className="flex items-center gap-2 text-[9px] opacity-70 font-black tracking-widest text-cyan-400">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></div>
              <span>DIAMOND SMART ENGINE V4</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 py-2 overflow-x-auto no-scrollbar">
          {[
            { id: 'dashboard',    label: 'میز کار',                  icon: LayoutDashboard },
            { id: 'exit',         label: 'خروج کالا',                icon: PackagePlus },
            { id: 'ppe',          label: 'ایمنی',                    icon: HardHat },
            { id: 'unregistered', label: 'خروج کالاهای ثبت نشده',   icon: AlertCircle },
            { id: 'warehouse',    label: 'انبار کالا',               icon: Box },
            { id: 'personnel',    label: 'پرسنل',                    icon: Users },
            { id: 'loans',        label: 'امانات',                   icon: RotateCcw },
            { id: 'waybills',     label: 'بارنامه‌ها',               icon: Truck },
            { id: 'log',          label: 'دفتر کل',                  icon: BookOpen },
            { id: 'reports',      label: 'گزارش‌گیری اکسل',          icon: BarChart3 },
            { id: 'system',       label: 'سیستم',                    icon: Settings },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl transition-all font-black text-[10px] whitespace-nowrap ${tab === t.id ? 'bg-indigo-600/90 shadow-[0_0_20px_rgba(99,102,241,0.4)] scale-105 neon-active-indigo text-white border-t border-white/20' : 'text-white/40 hover:bg-white/5 hover:text-white'}`}>
              <t.icon size={13}/>{t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-4">
          <div className="rotating-border-box">
            <div className="border-glow-ring"></div>
            <div className="inner-content shadow-2xl">
              <div className="flex flex-col items-start border-l border-white/10 pl-5">
                <div className="flex items-center gap-3">
                  <span className="text-[14px] font-black text-white ultra-glow-text leading-none tracking-tight">{currentUser.fullName}</span>
                  <div className="bg-indigo-500/10 px-2 py-0.5 rounded-md border border-indigo-500/20">
                    <span className="text-[9px] text-indigo-400 font-mono font-bold tracking-tighter">@{currentUser.username}</span>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 mt-1.5">
                  <div className={`w-1.5 h-1.5 rounded-full ${currentUser.role === UserRole.ADMIN ? 'bg-cyan-500' : 'bg-emerald-500'} animate-pulse shadow-[0_0_5px_currentColor]`}></div>
                  <span className="text-[9px] text-white/40 font-black uppercase tracking-[0.15em]">{currentUser.role === 'ADMIN' ? 'ادمین و سازنده پلتفرم' : 'اپراتور ارشد سیستم'}</span>
                </div>
              </div>
            </div>
          </div>
          <button onClick={() => setAiOpen(true)}  className="p-3 bg-indigo-600/10 rounded-2xl text-indigo-400 border border-indigo-500/20 hover:bg-indigo-600 hover:text-white transition-all shadow-lg"><Zap size={18}/></button>
          <button onClick={handleLogout}            className="p-3 bg-red-600/10 rounded-2xl text-red-500 hover:bg-red-600 hover:text-white transition-all border border-red-500/20 shadow-lg"><LogOut size={18}/></button>
        </div>
      </nav>

      {/* ── MAIN ── */}
      <main className="max-w-7xl mx-auto px-6">

        {tab === 'dashboard' && <DashboardView exits={[...exits, ...ppeRecords]} />}

        {tab === 'exit' && (
          <GeneralExitForm
            products={products} generalHistory={exits} recipients={recipients} currentUser={currentUser}
            onSave={async (rec: any) => {
              const res = await sendTelegramMessage(formatExitMessage(rec), false);
              update(prev => ({ ...prev, exits: [{ ...rec, telegramMsgId: res?.result?.message_id }, ...prev.exits] }));
              setTempSig(''); setTempPhoto(null);
            }}
            onRecordClick={setSelectedRecord} onEdit={requestEdit}
            onDelete={(id, type) => requestDelete(type, id)}
            onSignOpen={() => setSignOpen(true)} onCamOpen={() => setCamOpen(true)}
            signature={tempSig} photo={tempPhoto}
          />
        )}

        {tab === 'ppe' && (
          <SafetyIssuanceForm
            recipients={recipients} currentUser={currentUser} history={ppeRecords}
            onRecordClick={setSelectedRecord} onEdit={requestEdit}
            onDelete={(id, type) => requestDelete(type, id)}
            onSave={async (rec: any) => {
              await sendTelegramMessage(formatPpeMessage(rec), true);
              update(prev => ({ ...prev, ppeRecords: [rec, ...prev.ppeRecords] }));
              setTempSig(''); setTempPhoto(null);
            }}
            onSignOpen={() => setSignOpen(true)} onCamOpen={() => setCamOpen(true)}
            signature={tempSig} photo={tempPhoto}
          />
        )}

        {tab === 'unregistered' && (
          <UnregisteredExitsView
            exits={exits} products={products}
            onAssignCode={(recordId, itemIndex, newCode) => {
              const product = products.find(p => p.code === newCode);
              update(prev => ({
                ...prev,
                exits: prev.exits.map(rec => {
                  if (rec.id !== recordId) return rec;
                  const newItems = [...rec.items];
                  newItems[itemIndex] = {
                    ...newItems[itemIndex], productCode: newCode,
                    productDescription: product ? product.description : newItems[itemIndex].productDescription,
                    category: product ? product.category : newItems[itemIndex].category,
                  };
                  return { ...rec, items: newItems };
                }),
              }));
              alert('کد کالا با موفقیت تخصیص یافت و از لیست ثبت نشده‌ها خارج شد.');
            }}
          />
        )}

        {tab === 'warehouse' && (
          <WarehouseManager
            products={products}
            onAdd={(p: any) => { update(prev => ({ ...prev, products: [...prev.products, p] })); sendTelegramMessage(formatProductActionMessage('ADD', p, currentUser.fullName), false); }}
            onUpdate={(p: any) => secCheck(() => { update(prev => ({ ...prev, products: prev.products.map(x => x.code === p.code ? p : x) })); sendTelegramMessage(formatProductActionMessage('UPDATE', p, currentUser.fullName), false); }, `ویرایش کالای: ${p.description}`)}
            onDelete={(id: any) => requestDelete('PRODUCT', id)}
            isAdmin={currentUser.role === UserRole.ADMIN}
          />
        )}

        {tab === 'personnel' && (
          <PersonnelManager
            recipients={recipients}
            onAdd={(r: any) => { update(prev => ({ ...prev, recipients: [...prev.recipients, r] })); sendTelegramMessage(formatPersonnelActionMessage('ADD', r, currentUser.fullName), false); }}
            onUpdate={(r: any) => secCheck(() => { update(prev => ({ ...prev, recipients: prev.recipients.map(x => x.fullName === r.fullName ? r : x) })); sendTelegramMessage(formatPersonnelActionMessage('UPDATE', r, currentUser.fullName), false); }, `ویرایش اطلاعات پرسنل: ${r.fullName}`)}
            onDelete={(id: any) => requestDelete('RECIPIENT', id)}
            isAdmin={currentUser.role === UserRole.ADMIN}
          />
        )}

        {tab === 'loans' && (
          <LoanManager
            exits={[...exits, ...ppeRecords]}
            onRecordClick={setSelectedRecord}
            onReturn={(rid: any, idx: any, condition: string) => {
              const isExit = exits.some(e => e.id === rid);
              const list   = isExit ? exits : ppeRecords;
              const rec    = list.find(r => r.id === rid);
              if (!rec) return;
              const updatedItems = rec.items.filter((_, i) => i !== idx);
              update(prev => ({
                ...prev,
                exits:      isExit ? (updatedItems.length === 0 ? prev.exits.filter(r => r.id !== rid) : prev.exits.map(r => r.id === rid ? { ...rec, items: updatedItems } : r)) : prev.exits,
                ppeRecords: !isExit ? (updatedItems.length === 0 ? prev.ppeRecords.filter(r => r.id !== rid) : prev.ppeRecords.map(r => r.id === rid ? { ...rec, items: updatedItems } : r)) : prev.ppeRecords,
              }));
              sendTelegramMessage(formatReturnLoanMessage(rec.recipientName, rec.items[idx].productDescription, rec.docNumber, currentUser.fullName, condition), false);
            }}
          />
        )}

        {tab === 'waybills' && (
          <WaybillManager
            waybills={waybills} currentUser={currentUser}
            onSave={(wb) => update(prev => ({ ...prev, waybills: prev.waybills.some(w => w.id === wb.id) ? prev.waybills.map(w => w.id === wb.id ? wb : w) : [wb, ...prev.waybills] }))}
            onDelete={(id) => update(prev => ({ ...prev, waybills: prev.waybills.filter(w => w.id !== id) }))}
          />
        )}

        {tab === 'log' && (
          <GlobalLogView
            exits={[...exits, ...ppeRecords]} isAdmin={currentUser.role === UserRole.ADMIN}
            onRowClick={setSelectedRecord} onEdit={setEditingRecord}
            onDelete={(id, type) => requestDelete(type, id)}
          />
        )}

        {tab === 'reports' && (
          <ReportingView exits={[...exits, ...ppeRecords]} products={products} onRowClick={setSelectedRecord} />
        )}

        {tab === 'system' && (
          <SystemSettings
            currentUser={currentUser} users={users}
            onUpdateUser={(u: any) => {
              update(prev => ({ ...prev, users: prev.users.map(x => x.id === u.id ? u : x) }));
              if (u.id === currentUser.id) setCurrentUser(u);
              sendTelegramMessage(formatUserActionMessage('UPDATE', u, currentUser.fullName), false);
            }}
            onAddUser={(u: any) => {
              update(prev => ({ ...prev, users: [...prev.users, u] }));
              sendTelegramMessage(formatUserActionMessage('ADD', u, currentUser.fullName), false);
            }}
            onDeleteUser={(id: any) => secCheck(() => {
              const u = users.find(x => x.id === id);
              update(prev => ({ ...prev, users: prev.users.filter(x => x.id !== id) }));
              if (u) sendTelegramMessage(formatUserActionMessage('DELETE', u, currentUser.fullName), false);
            }, `حذف دسترسی کاربر: ${users.find(x => x.id === id)?.fullName}`)}
            db={{ products, exits, recipients, ppeRecords, users, waybills }}
            onRestore={(d: any) => {
              const restored: AppData = {
                products:   d.products   || [],
                exits:      d.exits      || [],
                recipients: d.recipients || [],
                ppeRecords: d.ppeRecords || d.ppe || [],
                waybills:   d.waybills   || [],
                users:      d.users      || users,
              };
              _dirty += 1;           // block poller immediately
              setData(restored);
              _doSave(restored);
              sendTelegramMessage(formatRestoreMessage(currentUser.fullName), false);
            }}
            isAdmin={currentUser.role === UserRole.ADMIN}
          />
        )}
      </main>

      {/* ── OVERLAYS ── */}
      {selectedRecord && <RecordOverlay record={selectedRecord} onClose={() => setSelectedRecord(null)} />}

      {editingRecord && (
        <EditOverlay
          record={editingRecord}
          onClose={() => setEditingRecord(null)}
          onSave={(rec: any) => {
            update(prev => ({
              ...prev,
              exits:      rec.type === 'EXIT' ? prev.exits.map(r => r.id === rec.id ? rec : r) : prev.exits,
              ppeRecords: rec.type !== 'EXIT' ? prev.ppeRecords.map(r => r.id === rec.id ? rec : r) : prev.ppeRecords,
            }));
            sendTelegramMessage(formatEditRecordMessage(rec, currentUser.fullName), false);
            setEditingRecord(null);
          }}
        />
      )}

      {secCtx && (
        <ModificationAuthModal
          onClose={() => setSecCtx(null)}
          onSuccess={() => { secCtx.action(); setSecCtx(null); }}
          onFail={() => { setSecCtx(null); handleLogout(); }}
          correctPass={currentUser.modPassword || ''}
          description={secCtx.desc}
        />
      )}

      {aiOpen   && <AIAssistantOverlay onClose={() => setAiOpen(false)} products={products} exits={[...exits, ...ppeRecords]} recipients={recipients} />}
      <SignatureModal isOpen={signOpen} onClose={(sig: string | null) => { if (sig) setTempSig(sig);    setSignOpen(false); }} name="پرسنل" />
      <CameraModal   isOpen={camOpen}  onClose={(p:   string | null) => { if (p)   setTempPhoto(p);    setCamOpen(false);  }} />
    </div>
  );
}
