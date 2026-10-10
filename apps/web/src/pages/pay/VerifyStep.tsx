/** Artboard 1e: last name + date of birth before anything about the visit is shown. */
import { useState, type FormEvent } from 'react';
import type { PatientBill, PayLinkInfo } from '@plainbill/api/contract';
import { ApiError, payApi } from '../../lib/api';

interface Props {
  token: string;
  practice: PayLinkInfo['practice'];
  onVerified: (bill: PatientBill) => void;
}

const digits = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max);

export function VerifyStep({ token, practice, onVerified }: Props) {
  const [lastName, setLastName] = useState('');
  const [month, setMonth] = useState('');
  const [day, setDay] = useState('');
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = lastName.trim() && month && day && year.length === 4;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      onVerified(await payApi.verify(token, { lastName, month, day, year }));
    } catch (err) {
      if (err instanceof ApiError) {
        const left = err.extra.attemptsLeft;
        setError(
          typeof left === 'number' && left <= 2
            ? `${err.message} ${left} ${left === 1 ? 'try' : 'tries'} left.`
            : err.message,
        );
      } else setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="pay-verify" onSubmit={submit} noValidate>
      <div>
        <h1 className="pay-h1">Let’s find your bill</h1>
        <p className="pay-lede">To keep your information private, please confirm two things.</p>
      </div>

      <div className="pay-field">
        <label htmlFor="pay-last">Last name</label>
        <input
          id="pay-last"
          className="pay-input"
          autoComplete="family-name"
          autoCapitalize="words"
          value={lastName}
          onChange={(e) => setLastName(e.target.value)}
        />
      </div>

      <fieldset className="pay-field">
        <legend>Date of birth</legend>
        <div className="pay-dob">
          <div>
            <input
              id="pay-month"
              className="pay-input"
              inputMode="numeric"
              autoComplete="bday-month"
              placeholder="MM"
              aria-label="Month"
              value={month}
              onChange={(e) => setMonth(digits(e.target.value, 2))}
            />
            <span className="pay-hint">Month</span>
          </div>
          <div>
            <input
              id="pay-day"
              className="pay-input"
              inputMode="numeric"
              autoComplete="bday-day"
              placeholder="DD"
              aria-label="Day"
              value={day}
              onChange={(e) => setDay(digits(e.target.value, 2))}
            />
            <span className="pay-hint">Day</span>
          </div>
          <div>
            <input
              id="pay-year"
              className="pay-input"
              inputMode="numeric"
              autoComplete="bday-year"
              placeholder="YYYY"
              aria-label="Year"
              value={year}
              onChange={(e) => setYear(digits(e.target.value, 4))}
            />
            <span className="pay-hint">Year</span>
          </div>
        </div>
      </fieldset>

      {error && (
        <p className="pay-error" role="alert">
          {error}
        </p>
      )}

      <div className="pay-spacer" />
      <button type="submit" className="pay-btn-primary" disabled={!ready || busy}>
        {busy ? 'Checking…' : 'View my bill'}
      </button>
      <p className="pay-fine">
        We’ll never ask for your Social Security or insurance ID here.
        <br />
        Trouble? Call <a href={`tel:${practice.phone.replace(/\D/g, '')}`}>{practice.phone}</a>
      </p>
    </form>
  );
}
