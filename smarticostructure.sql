/* ===========================================================
   1) EXTENDER affiliate_contracts (sem remover nada)
   ----------------------------------------------------------- */
ALTER TABLE affiliate_contracts
  ADD COLUMN commission_model ENUM('CPA','CPL','REVSHARE','HYBRID') NULL AFTER contract_type,
  ADD COLUMN model_notes VARCHAR(500) NULL AFTER commission_model,
  ADD COLUMN valid_from DATETIME NULL AFTER end_date,
  ADD COLUMN valid_to   DATETIME NULL AFTER valid_from,
  ADD COLUMN is_exclusive TINYINT(1) NOT NULL DEFAULT 0 AFTER valid_to;

/* ===========================================================
   2) CONTRACT COMPONENTS (CPA / CPL / REVSHARE dentro do contrato)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS contract_components (
  id                CHAR(36) NOT NULL,
  contract_id       CHAR(36) NOT NULL,
  component_type    ENUM('CPA','CPL','REVSHARE') NOT NULL,
  currency          VARCHAR(3) NOT NULL DEFAULT 'BRL',
  -- FIXO (CPA/CPL)
  fixed_amount      DECIMAL(18,2) NULL,
  -- PERCENTUAL (REVSHARE)
  percent_value     DECIMAL(10,4) NULL,
  -- REGRAS DE QUALIFICAÇÃO (comuns)
  qualifier_ftd_amount_min   DECIMAL(18,2) NULL,  -- p/ CPA baseado em FTD mínimo
  qualifier_total_deposit_min DECIMAL(18,2) NULL, -- p/ CPA por total depositado
  qualifier_volume_bet_min    DECIMAL(18,2) NULL, -- p/ volume (apostas/turnover)
  qualifier_activity_count_min INT NULL,          -- p/ # eventos (ex. apostas)
  -- REVSHARE específico
  revshare_on                ENUM('NGR','GGR') DEFAULT 'NGR',
  revshare_recurring_months  INT NULL,           -- por quantos meses pagar revshare do jogador
  revshare_grace_days        INT NULL,           -- carência inicial (dias)
  -- LIMITES/CAPS por componente
  cap_amount_total  DECIMAL(18,2) NULL,
  cap_count_total   INT NULL,
  -- VIGÊNCIA opcional específica do componente
  start_at          DATETIME NULL,
  end_at            DATETIME NULL,
  status            ENUM('active','paused','ended') NOT NULL DEFAULT 'active',
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NULL,
  PRIMARY KEY (id),
  KEY k_contract_components_contract (contract_id),
  CONSTRAINT fk_contract_components_contract
    FOREIGN KEY (contract_id) REFERENCES affiliate_contracts(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   3) TIERS POR CONTRACT COMPONENT (degraus por metas)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS contract_tiers (
  id              CHAR(36) NOT NULL,
  component_id    CHAR(36) NOT NULL,
  tier_order      INT NOT NULL,                  -- 1,2,3...
  -- gatilhos (qualquer um pode ser usado, conforme o componente)
  threshold_ftd_count      INT NULL,
  threshold_total_deposit  DECIMAL(18,2) NULL,
  threshold_volume_bet     DECIMAL(18,2) NULL,
  threshold_revenue        DECIMAL(18,2) NULL,
  -- valores a aplicar quando bater o tier
  fixed_amount      DECIMAL(18,2) NULL,          -- CPA/CPL
  percent_value     DECIMAL(10,4) NULL,          -- RevShare %
  effective_from    DATETIME NULL,
  effective_to      DATETIME NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NULL,
  PRIMARY KEY (id),
  KEY k_tiers_component (component_id),
  CONSTRAINT fk_tiers_component
    FOREIGN KEY (component_id) REFERENCES contract_components(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   4) GEO / REGRAS DE APLICAÇÃO POR CONTRACT
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS contract_geo_rules (
  id               CHAR(36) NOT NULL,
  contract_id      CHAR(36) NOT NULL,
  rule_type        ENUM('INCLUDE','EXCLUDE') NOT NULL,
  country_iso2     CHAR(2) NOT NULL,
  state_code       VARCHAR(10) NULL,
  product          ENUM('casino','sports','poker','other') NULL,
  brand_casino_id  CHAR(36) NULL,                -- se quiser limitar a um cassino / marca
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_geo_contract (contract_id),
  CONSTRAINT fk_geo_contract
    FOREIGN KEY (contract_id) REFERENCES affiliate_contracts(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   5) CAPS (LIMITES) POR AFILIADO/CONTRATO (por período)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS contract_caps (
  id               CHAR(36) NOT NULL,
  contract_id      CHAR(36) NOT NULL,
  period           ENUM('daily','weekly','monthly','lifetime') NOT NULL,
  cap_commission_amount DECIMAL(18,2) NULL,
  cap_commission_count  INT NULL,
  cap_ftd_count         INT NULL,
  cap_lead_count        INT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_caps_contract (contract_id),
  CONSTRAINT fk_caps_contract
    FOREIGN KEY (contract_id) REFERENCES affiliate_contracts(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   6) TRACKING DE LEAD (CPL)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS lead_events (
  id               CHAR(36) NOT NULL,
  affiliate_id     CHAR(36) NOT NULL,
  affiliate_link_id INT NULL,
  casino_id        CHAR(36) NULL,
  player_id        CHAR(36) NULL,               -- pode ser NULL no momento do lead
  click_id         CHAR(36) NULL,
  email            VARCHAR(190) NULL,
  phone            VARCHAR(40) NULL,
  country_iso2     CHAR(2) NULL,
  occurred_at      DATETIME NOT NULL,
  qualified        TINYINT(1) NOT NULL DEFAULT 0,
  qualification_reason VARCHAR(255) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_lead_aff (affiliate_id),
  KEY k_lead_player (player_id),
  CONSTRAINT fk_lead_aff
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   7) TRACKING DE AQUISIÇÃO / FTD (CPA)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS acquisition_events (
  id               CHAR(36) NOT NULL,
  affiliate_id     CHAR(36) NOT NULL,
  casino_id        CHAR(36) NOT NULL,
  player_id        CHAR(36) NOT NULL,
  first_deposit_amount DECIMAL(18,2) NULL,
  total_deposit_amount DECIMAL(18,2) NULL,
  deposit_count    INT NULL,
  volume_bet       DECIMAL(18,2) NULL,
  occurred_at      DATETIME NOT NULL,
  qualified        TINYINT(1) NOT NULL DEFAULT 0,
  qualification_reason VARCHAR(255) NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_acq_aff (affiliate_id),
  KEY k_acq_player (player_id),
  CONSTRAINT fk_acq_aff
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   8) RECEITA DIÁRIA POR JOGADOR (RevShare)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS player_revenue_daily (
  id               CHAR(36) NOT NULL,
  casino_id        CHAR(36) NOT NULL,
  player_id        CHAR(36) NOT NULL,
  affiliate_id     CHAR(36) NOT NULL,
  day_date         DATE NOT NULL,
  ggr              DECIMAL(18,2) NULL,           -- Gross Gaming Revenue
  bonus_cost       DECIMAL(18,2) NULL,
  fees_cost        DECIMAL(18,2) NULL,
  adjustments      DECIMAL(18,2) NULL,
  ngr              DECIMAL(18,2) GENERATED ALWAYS AS (COALESCE(ggr,0)-COALESCE(bonus_cost,0)-COALESCE(fees_cost,0)+COALESCE(adjustments,0)) VIRTUAL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_rev (player_id, day_date),
  KEY k_rev_aff (affiliate_id),
  CONSTRAINT fk_rev_aff
    FOREIGN KEY (affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   9) (OPCIONAL) CLICKS — para atribuição e janelas
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS click_events (
  id               CHAR(36) NOT NULL,
  affiliate_link_id INT NULL,
  affiliate_id     CHAR(36) NOT NULL,
  casino_id        CHAR(36) NULL,
  player_id        CHAR(36) NULL,
  ip               VARBINARY(16) NULL,
  user_agent       VARCHAR(255) NULL,
  occurred_at      DATETIME NOT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_click_aff (affiliate_id)
) ENGINE=InnoDB;

/* ===========================================================
   10) REDE DE SUB-AFILIADOS (árvore e overrides)
   ----------------------------------------------------------- */
CREATE TABLE IF NOT EXISTS affiliate_tree (
  parent_affiliate_id CHAR(36) NOT NULL,
  child_affiliate_id  CHAR(36) NOT NULL,
  share_percent       DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (parent_affiliate_id, child_affiliate_id),
  CONSTRAINT fk_tree_parent FOREIGN KEY (parent_affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_tree_child  FOREIGN KEY (child_affiliate_id)  REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS subaffiliate_commissions (
  id                CHAR(36) NOT NULL,
  parent_affiliate_id CHAR(36) NOT NULL,
  child_affiliate_id  CHAR(36) NOT NULL,
  commission_id     CHAR(36) NOT NULL,     -- comissão original gerada para o filho
  amount            DECIMAL(18,2) NOT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY k_sub_comm_parent (parent_affiliate_id),
  KEY k_sub_comm_child  (child_affiliate_id),
  CONSTRAINT fk_sub_comm_parent FOREIGN KEY (parent_affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT fk_sub_comm_child FOREIGN KEY (child_affiliate_id) REFERENCES affiliates(id)
    ON UPDATE CASCADE ON DELETE CASCADE
) ENGINE=InnoDB;

/* ===========================================================
   11) EXTENDER commissions (guardar o “componente” e a origem)
   ----------------------------------------------------------- */
ALTER TABLE commissions
  ADD COLUMN component_type ENUM('CPA','CPL','REVSHARE') NULL AFTER commission_amount,
  ADD COLUMN source_event_id CHAR(36) NULL AFTER component_type,  -- id do lead/acquisition/revenue
  ADD COLUMN percent_applied DECIMAL(10,4) NULL AFTER source_event_id,
  ADD COLUMN fixed_applied   DECIMAL(18,2) NULL AFTER percent_applied,
  ADD COLUMN model_snapshot  JSON NULL AFTER fixed_applied;  -- guarda parâmetros do contrato usados no cálculo