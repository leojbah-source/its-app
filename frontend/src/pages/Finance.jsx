// src/pages/Finance.jsx
// Income & expenses tracking for the active year. Summary (income / expenses /
// net), income entries, expense entries by head, and expense-head management.
import { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Plus, Trash2, Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import AdminLayout from '../components/layout/AdminLayout';
import { Card, Badge } from '../components/ui/Card';
import Button from '../components/ui/Button';
import { PageLoader } from '../components/ui/States';
import { useAuth } from '../context/AuthContext';
import { financeApi, yearConfigApi } from '../api/client';

const money = (v) => `BHD ${Number(v || 0).toFixed(3)}`;
const today = () => new Date().toISOString().slice(0, 10);

export default function Finance() {
  const { token } = useAuth();
  const [yearId, setYearId] = useState(null);
  const [summary, setSummary] = useState(null);
  const [income, setIncome] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [heads, setHeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState('');

  const [inc, setInc] = useState({ source: '', amount: '', date: today(), notes: '' });
  const [exp, setExp] = useState({ expense_head_id: '', amount: '', date: today(), vendor: '', notes: '' });
  const [headName, setHeadName] = useState('');

  const loadAll = useCallback(async (yId) => {
    setLoading(true); setFlash('');
    try {
      const [s, i, e, h] = await Promise.all([
        financeApi.summary(token, yId), financeApi.income(token, yId),
        financeApi.expenses(token, yId), financeApi.heads(token, yId),
      ]);
      setSummary(s); setIncome(i); setExpenses(e); setHeads(h);
    } catch (err) { setFlash(err.message); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => {
    yearConfigApi.get(token).then((cfg) => { setYearId(cfg.id); loadAll(cfg.id); })
      .catch((e) => { setFlash(e.message); setLoading(false); });
  }, [token, loadAll]);

  async function addIncome(e) {
    e.preventDefault();
    if (!inc.source.trim() || !inc.amount || !inc.date) return;
    try {
      await financeApi.addIncome(token, { year_id: yearId, ...inc, amount: Number(inc.amount) });
      setInc({ source: '', amount: '', date: today(), notes: '' }); loadAll(yearId);
    } catch (err) { setFlash(err.message); }
  }
  async function addExpense(e) {
    e.preventDefault();
    if (!exp.expense_head_id || !exp.amount || !exp.date) return;
    try {
      await financeApi.addExpense(token, { year_id: yearId, ...exp, expense_head_id: Number(exp.expense_head_id), amount: Number(exp.amount) });
      setExp({ expense_head_id: '', amount: '', date: today(), vendor: '', notes: '' }); loadAll(yearId);
    } catch (err) { setFlash(err.message); }
  }
  async function addHead(e) {
    e.preventDefault();
    if (!headName.trim()) return;
    try { await financeApi.addHead(token, { year_id: yearId, name: headName.trim() }); setHeadName(''); loadAll(yearId); }
    catch (err) { setFlash(err.message); }
  }
  async function delIncome(id) { try { await financeApi.deleteIncome(token, id); loadAll(yearId); } catch (e) { setFlash(e.message); } }
  async function delExpense(id) { try { await financeApi.deleteExpense(token, id); loadAll(yearId); } catch (e) { setFlash(e.message); } }

  const input = 'rounded-md border border-slate-300 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-navy-300';

  if (loading) return <AdminLayout title="Finance"><PageLoader label="Loading finance…" /></AdminLayout>;

  return (
    <AdminLayout title="Finance" subtitle="Income and expenses for the active year.">
      {flash && <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{flash}</div>}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card><div className="flex items-center gap-3"><TrendingUp className="text-green-600" size={22} /><div><div className="text-lg font-bold text-navy-800">{money(summary?.totalIncome)}</div><div className="text-xs text-slate-500">Total income</div></div></div></Card>
        <Card><div className="flex items-center gap-3"><TrendingDown className="text-red-600" size={22} /><div><div className="text-lg font-bold text-navy-800">{money(summary?.totalExpenses)}</div><div className="text-xs text-slate-500">Total expenses</div></div></div></Card>
        <Card><div className="flex items-center gap-3"><Wallet className="text-navy-600" size={22} /><div><div className={`text-lg font-bold ${Number(summary?.net) < 0 ? 'text-red-600' : 'text-navy-800'}`}>{money(summary?.net)}</div><div className="text-xs text-slate-500">Balance</div></div></div></Card>
      </div>

      <div className="mb-2 flex justify-end"><Button variant="outline" icon={RefreshCw} onClick={() => loadAll(yearId)}>Refresh</Button></div>

      {/* INCOME */}
      <Card className="mb-4">
        <h2 className="mb-2 text-sm font-semibold text-navy-800">Income</h2>
        <form onSubmit={addIncome} className="mb-3 flex flex-wrap items-end gap-2">
          <input value={inc.source} onChange={(e) => setInc({ ...inc, source: e.target.value })} placeholder="Source (e.g. Entry fees)" className={`${input} flex-1 min-w-[10rem]`} />
          <input value={inc.amount} onChange={(e) => setInc({ ...inc, amount: e.target.value })} type="number" step="0.001" min="0" placeholder="Amount" className={`${input} w-28`} />
          <input value={inc.date} onChange={(e) => setInc({ ...inc, date: e.target.value })} type="date" className={input} />
          <input value={inc.notes} onChange={(e) => setInc({ ...inc, notes: e.target.value })} placeholder="Notes" className={`${input} flex-1 min-w-[8rem]`} />
          <Button type="submit" variant="primary" icon={Plus}>Add</Button>
        </form>
        {income.length === 0 ? <p className="text-sm text-slate-400">No income entries yet.</p>
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Source</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1 text-left">Notes</th><th></th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {income.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-1 text-slate-500">{String(r.date).slice(0, 10)}</td>
                      <td className="px-2 py-1 font-medium">{r.source}</td>
                      <td className="px-2 py-1 text-right text-green-700">{money(r.amount)}</td>
                      <td className="px-2 py-1 text-slate-500">{r.notes || ''}</td>
                      <td className="px-2 py-1 text-right"><button onClick={() => delIncome(r.id)} className="text-slate-400 hover:text-red-600" title="Delete"><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>

      {/* EXPENSES */}
      <Card className="mb-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-navy-800">Expenses</h2>
        </div>
        <form onSubmit={addHead} className="mb-3 flex items-end gap-2">
          <input value={headName} onChange={(e) => setHeadName(e.target.value)} placeholder="New expense head (e.g. Trophies)" className={`${input} w-64`} />
          <Button type="submit" variant="outline" icon={Plus}>Add head</Button>
          {heads.length > 0 && <span className="text-xs text-slate-400">Heads: {heads.map((h) => h.name).join(', ')}</span>}
        </form>
        <form onSubmit={addExpense} className="mb-3 flex flex-wrap items-end gap-2">
          <select value={exp.expense_head_id} onChange={(e) => setExp({ ...exp, expense_head_id: e.target.value })} className={input}>
            <option value="">Category…</option>
            {heads.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
          <input value={exp.amount} onChange={(e) => setExp({ ...exp, amount: e.target.value })} type="number" step="0.001" min="0" placeholder="Amount" className={`${input} w-28`} />
          <input value={exp.date} onChange={(e) => setExp({ ...exp, date: e.target.value })} type="date" className={input} />
          <input value={exp.vendor} onChange={(e) => setExp({ ...exp, vendor: e.target.value })} placeholder="Vendor" className={`${input} min-w-[8rem]`} />
          <input value={exp.notes} onChange={(e) => setExp({ ...exp, notes: e.target.value })} placeholder="Notes" className={`${input} flex-1 min-w-[8rem]`} />
          <Button type="submit" variant="primary" icon={Plus} disabled={!heads.length}>Add</Button>
        </form>
        {!heads.length && <p className="mb-2 text-xs text-amber-600">Add an expense head first before recording an expense.</p>}
        {expenses.length === 0 ? <p className="text-sm text-slate-400">No expense entries yet.</p>
          : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="text-xs uppercase text-slate-500"><tr><th className="px-2 py-1 text-left">Date</th><th className="px-2 py-1 text-left">Category</th><th className="px-2 py-1 text-left">Vendor</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1 text-left">Notes</th><th></th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {expenses.map((r) => (
                    <tr key={r.id}>
                      <td className="px-2 py-1 text-slate-500">{String(r.date).slice(0, 10)}</td>
                      <td className="px-2 py-1 font-medium">{r.expense_head_name || '—'}</td>
                      <td className="px-2 py-1 text-slate-500">{r.vendor || ''}</td>
                      <td className="px-2 py-1 text-right text-red-700">{money(r.amount)}</td>
                      <td className="px-2 py-1 text-slate-500">{r.notes || ''}</td>
                      <td className="px-2 py-1 text-right"><button onClick={() => delExpense(r.id)} className="text-slate-400 hover:text-red-600" title="Delete"><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </Card>
    </AdminLayout>
  );
}
