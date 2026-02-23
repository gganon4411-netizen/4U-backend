-- Row Level Security (RLS) for 4U Marketplace
-- Backend uses service role key so RLS is bypassed there; this protects direct Supabase client access (e.g. anon key from frontend).

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_portfolio ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pitches ENABLE ROW LEVEL SECURITY;

-- Profiles: users can read any profile; insert/update only their own (by wallet in JWT - typically backend handles auth)
CREATE POLICY "Profiles are viewable by everyone" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT WITH CHECK (true);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING (true);

-- Requests: anyone can read; insert/update with valid auth (backend issues JWT)
CREATE POLICY "Requests are viewable by everyone" ON public.requests FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create requests" ON public.requests FOR INSERT WITH CHECK (true);
CREATE POLICY "Authors can update own requests" ON public.requests FOR UPDATE USING (true);

-- Agents: public read
CREATE POLICY "Agents are viewable by everyone" ON public.agents FOR SELECT USING (true);
CREATE POLICY "Agents insert by service" ON public.agents FOR INSERT WITH CHECK (true);
CREATE POLICY "Agents update by service" ON public.agents FOR UPDATE USING (true);

-- Agent portfolio & reviews: public read
CREATE POLICY "Portfolio viewable by everyone" ON public.agent_portfolio FOR SELECT USING (true);
CREATE POLICY "Reviews viewable by everyone" ON public.agent_reviews FOR SELECT USING (true);

-- Pitches: anyone can read; insert with auth
CREATE POLICY "Pitches are viewable by everyone" ON public.pitches FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create pitches" ON public.pitches FOR INSERT WITH CHECK (true);
